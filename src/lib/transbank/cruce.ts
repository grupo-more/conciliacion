import type { TbkTesoreria, TransbankSale } from "@prisma/client";

/**
 * Matching POS (TbkTesoreria / "Dynatech") ↔ settlement Transbank
 * (TransbankSale, archivo "Abonos por día"). 1:1.
 *
 * Llave: opNumber (POS) == numeroBoleta (settlement) + monto bruto. Fallback:
 * monto bruto exacto + fecha (±1.5d) + sucursal. Compartido entre la vista de
 * Cruce Transbank y la cuadratura (asiento), para que no se desincronicen.
 */

// El settlement de Transbank suma el RECARGO de crédito (~2%) sobre el monto
// base del POS. Para débito la diferencia es 0; para crédito ~2%. Aceptamos
// hasta este % y dejamos la diferencia visible (auditable).
export const MATCH_TOLERANCE = 0.05;

export interface CrucePair {
  pos: TbkTesoreria;
  sett: TransbankSale | null;
  /** settlement bruto (montoVenta) − POS base (recargo crédito). */
  diff: bigint;
}

export interface CruceResult {
  pairs: CrucePair[];
  settlementOnly: TransbankSale[];
}

const absB = (n: bigint) => (n < 0n ? -n : n);

/**
 * Empareja POS contra settlement. Asume que los arreglos ya vienen filtrados
 * (rango, anulados, ya-consumidos por cuadraturas previas, etc.).
 */
export function matchCruce(posAll: TbkTesoreria[], settAll: TransbankSale[]): CruceResult {
  // Índice de settlements por boleta(=OP); una OP puede repetirse en POS.
  const settByBoleta = new Map<string, TransbankSale[]>();
  for (const sv of settAll) {
    if (!sv.numeroBoleta) continue;
    (settByBoleta.get(sv.numeroBoleta) ?? settByBoleta.set(sv.numeroBoleta, []).get(sv.numeroBoleta)!).push(sv);
  }
  const usedSett = new Set<string>();
  const pairs: CrucePair[] = [];

  // Pass 1: por boleta(=OP), elegir el settlement de monto más cercano dentro
  // de la tolerancia (débito exacto, crédito dentro del recargo).
  const unmatchedPos: TbkTesoreria[] = [];
  for (const pos of posAll) {
    const op = pos.opNumber;
    let best: TransbankSale | null = null;
    let bestDiff = 0n;
    if (op) {
      const base = absB(pos.monto);
      for (const c of settByBoleta.get(op) ?? []) {
        if (usedSett.has(c.id)) continue;
        const diff = c.montoVenta - pos.monto;
        if (base > 0n && Number(absB(diff)) / Number(base) > MATCH_TOLERANCE) continue;
        if (best === null || absB(diff) < absB(bestDiff)) {
          best = c;
          bestDiff = diff;
        }
      }
    }
    if (best) {
      usedSett.add(best.id);
      pairs.push({ pos, sett: best, diff: bestDiff });
    } else {
      unmatchedPos.push(pos);
    }
  }

  // Pass 2: fallback por monto exacto + fecha (±1.5d) para los sin boleta.
  const freeSett = settAll.filter((s) => !usedSett.has(s.id));
  const dayMs = 86400000;
  for (const pos of unmatchedPos) {
    const cand = freeSett.find(
      (s) =>
        !usedSett.has(s.id) &&
        s.montoVenta === pos.monto &&
        Math.abs(pos.fecha.getTime() - s.fechaVenta.getTime()) <= dayMs * 1.5 &&
        (s.sucursalId == null || s.sucursalId === pos.sucursalId),
    );
    if (cand) {
      usedSett.add(cand.id);
      pairs.push({ pos, sett: cand, diff: 0n });
    } else {
      pairs.push({ pos, sett: null, diff: 0n });
    }
  }

  const settlementOnly = settAll.filter((s) => !usedSett.has(s.id));
  return { pairs, settlementOnly };
}
