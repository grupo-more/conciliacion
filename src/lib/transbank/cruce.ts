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

/** Vínculo manual POS↔settlement que el matching fuerza como cuadrado. */
export interface ManualLink {
  tbkTesoreriaId: string;
  transbankSaleId: string;
}

const absB = (n: bigint) => (n < 0n ? -n : n);

/**
 * Empareja POS contra settlement. Asume que los arreglos ya vienen filtrados
 * (rango, anulados, ya-consumidos por cuadraturas previas, etc.).
 *
 * `manualLinks` se fuerzan como cuadrados ANTES de las pasadas automáticas
 * (Pasada 0), y ambos lados salen del pool. Sirve para pares sin llave común.
 */
export function matchCruce(
  posAll: TbkTesoreria[],
  settAll: TransbankSale[],
  manualLinks: ManualLink[] = [],
): CruceResult {
  const usedSett = new Set<string>();
  const usedPos = new Set<string>();
  const pairs: CrucePair[] = [];

  // Pass 0: vínculos manuales (forzados). Se emparejan sin importar la llave ni
  // el monto; la diferencia se calcula igual (queda visible/auditable).
  if (manualLinks.length) {
    const posById = new Map(posAll.map((p) => [p.id, p]));
    const settById = new Map(settAll.map((s) => [s.id, s]));
    for (const l of manualLinks) {
      const pos = posById.get(l.tbkTesoreriaId);
      const sett = settById.get(l.transbankSaleId);
      if (!pos || !sett || usedPos.has(pos.id) || usedSett.has(sett.id)) continue;
      usedPos.add(pos.id);
      usedSett.add(sett.id);
      pairs.push({ pos, sett, diff: sett.montoVenta - pos.monto });
    }
  }

  const dayMs = 86400000;
  // El N° de boleta (3-4 dígitos) se RECICLA: no es llave única. Para no cruzar
  // ventas distintas que comparten boleta (ej. SUECIA 02-06 vs VALPARAISO 17-06),
  // el match por boleta exige además misma sucursal y fecha cercana. Los matches
  // legítimos caen a 0-1 día; este margen rechaza los reciclados (>7d / otra suc).
  const BOLETA_WINDOW_DAYS = 3;

  // Índice de settlements por boleta(=OP); una OP puede repetirse en POS.
  const settByBoleta = new Map<string, TransbankSale[]>();
  for (const sv of settAll) {
    if (!sv.numeroBoleta) continue;
    (settByBoleta.get(sv.numeroBoleta) ?? settByBoleta.set(sv.numeroBoleta, []).get(sv.numeroBoleta)!).push(sv);
  }

  // Pass 1: por boleta(=OP) + sucursal + fecha, elegir el settlement de monto
  // más cercano dentro de la tolerancia (débito exacto, crédito dentro del recargo).
  const unmatchedPos: TbkTesoreria[] = [];
  for (const pos of posAll) {
    if (usedPos.has(pos.id)) continue; // ya fijado por vínculo manual
    const op = pos.opNumber;
    let best: TransbankSale | null = null;
    let bestDiff = 0n;
    if (op) {
      const base = absB(pos.monto);
      for (const c of settByBoleta.get(op) ?? []) {
        if (usedSett.has(c.id)) continue;
        // Boleta reciclada: exigir misma sucursal (si el settlement la trae) y
        // fecha cercana, para no emparejar ventas distintas con igual N° boleta.
        if (c.sucursalId != null && c.sucursalId !== pos.sucursalId) continue;
        if (Math.abs(pos.fecha.getTime() - c.fechaVenta.getTime()) > dayMs * BOLETA_WINDOW_DAYS) continue;
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

  // Pass 2: fallback SIN boleta, por sucursal + fecha (±1.5d). Dos etapas:
  //   2a) monto EXACTO → match (máxima confianza, débito sin recargo).
  //   2b) sin exacto, match tolerante: la diferencia esperada es el RECARGO DE
  //       CRÉDITO DE TRANSBANK (~2% que Transbank suma sobre la boleta; débito
  //       = 0). Se acepta dentro de MATCH_TOLERANCE PERO solo si hay UN único
  //       candidato dentro de la tolerancia en esa sucursal+fecha.
  //       La unicidad es la garantía de seguridad: sin boleta, el monto+fecha+
  //       sucursal solo es confiable cuando no hay ambigüedad. Si hay 2+ dentro
  //       de tolerancia, NO se toca (queda "sin settlement" para revisión manual).
  // La diferencia (recargo) queda visible y va al rubro 1403 en el asiento.
  for (const pos of unmatchedPos) {
    const base = absB(pos.monto);
    const cands = settAll.filter(
      (s) =>
        !usedSett.has(s.id) &&
        Math.abs(pos.fecha.getTime() - s.fechaVenta.getTime()) <= dayMs * 1.5 &&
        (s.sucursalId == null || s.sucursalId === pos.sucursalId),
    );
    // 2a) exacto
    let chosen = cands.find((s) => s.montoVenta === pos.monto) ?? null;
    let diff = 0n;
    // 2b) tolerante con candidato único
    if (!chosen && base > 0n) {
      const within = cands.filter(
        (s) => Number(absB(s.montoVenta - pos.monto)) / Number(base) <= MATCH_TOLERANCE,
      );
      if (within.length === 1) {
        chosen = within[0];
        diff = chosen.montoVenta - pos.monto;
      }
    }
    if (chosen) {
      usedSett.add(chosen.id);
      pairs.push({ pos, sett: chosen, diff });
    } else {
      pairs.push({ pos, sett: null, diff: 0n });
    }
  }

  const settlementOnly = settAll.filter((s) => !usedSett.has(s.id));
  return { pairs, settlementOnly };
}
