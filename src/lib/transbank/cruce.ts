import type { TbkTesoreria, TransbankSale } from "@prisma/client";

/**
 * Matching POS (TbkTesoreria / "Dynatech") ↔ settlement Transbank
 * (TransbankSale, archivo "Abonos por día"). 1:1 en general, con soporte 1:N
 * para giros pagados en 2+ transacciones de tarjeta (ej. "N OPE 4047/4048").
 *
 * Llave: opNumber (POS) == numeroBoleta (settlement) + monto bruto. Fallback:
 * monto bruto exacto + fecha (±1.5d) + sucursal. Compartido entre la vista de
 * Cruce Transbank y la cuadratura (asiento), para que no se desincronicen.
 */

// El settlement de Transbank suma el RECARGO de crédito (~2%) sobre el monto
// base del POS. Para débito la diferencia es 0; para crédito ~2%. Aceptamos
// hasta este % y dejamos la diferencia visible (auditable).
export const MATCH_TOLERANCE = 0.05;

// Tolerancia del match multi-boleta (Pass 1.5): la suma de los settlements
// nombrados en la glosa debe calzar con el POS al peso (débito) o dentro del
// recargo de crédito. Más estricta que MATCH_TOLERANCE a propósito: acá no hay
// unicidad de candidato que proteja, la protege la suma.
export const MULTI_TOLERANCE = 0.025;

export interface CrucePair {
  pos: TbkTesoreria;
  /** settlements cuadrados con este POS: [] = sin settlement, 1 = normal, 2+ = grupo (pago dividido). */
  setts: TransbankSale[];
  /** suma settlement bruto (montoVenta) − POS base (recargo crédito). */
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
 * Extrae boletas múltiples de la glosa del POS: "N OPE 4047/4048" → [4047,4048],
 * "OP.0515-516" → [515,516]. Solo pares de números de 3-4 dígitos separados por
 * / o - (una fecha "29-05-26" o un RUT "…045-3" no calzan el patrón). Si la
 * notación es rango corto (515-518) se expande; si no, es lista de 2.
 * Devuelve null si la glosa no nombra 2+ boletas distintas.
 */
export function extractMultiBoletas(glosa: string | null | undefined): string[] | null {
  if (!glosa) return null;
  const m = glosa.match(/(?<!\d)(\d{3,4})\s*[/-]\s*0*(\d{3,4})(?!\d)/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  // Rango corto ascendente (515-516, 515-518) → expandir. Lo demás, lista de 2.
  const out: number[] = b > a && b - a <= 4 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a, b];
  return out.map(String);
}

/**
 * Empareja POS contra settlement. Asume que los arreglos ya vienen filtrados
 * (rango, anulados, ya-consumidos por cuadraturas previas, etc.).
 *
 * `manualLinks` se fuerzan como cuadrados ANTES de las pasadas automáticas
 * (Pasada 0), agrupando los N settlements de un mismo POS en un solo par.
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
  // el monto; la diferencia se calcula igual (queda visible/auditable). Un POS
  // con varios links forma UN par con todos sus settlements (1:N).
  if (manualLinks.length) {
    const posById = new Map(posAll.map((p) => [p.id, p]));
    const settById = new Map(settAll.map((s) => [s.id, s]));
    const byPos = new Map<string, string[]>();
    for (const l of manualLinks) {
      (byPos.get(l.tbkTesoreriaId) ?? byPos.set(l.tbkTesoreriaId, []).get(l.tbkTesoreriaId)!).push(
        l.transbankSaleId,
      );
    }
    for (const [posId, settIds] of byPos) {
      const pos = posById.get(posId);
      if (!pos || usedPos.has(pos.id)) continue;
      const setts: TransbankSale[] = [];
      for (const sid of settIds) {
        const sett = settById.get(sid);
        if (sett && !usedSett.has(sett.id)) setts.push(sett);
      }
      if (!setts.length) continue;
      usedPos.add(pos.id);
      for (const s of setts) usedSett.add(s.id);
      const sum = setts.reduce((acc, s) => acc + s.montoVenta, 0n);
      pairs.push({ pos, setts, diff: sum - pos.monto });
    }
  }

  const dayMs = 86400000;
  // El N° de boleta (3-4 dígitos) se RECICLA: no es llave única. Para no cruzar
  // ventas distintas que comparten boleta (ej. SUECIA 02-06 vs VALPARAISO 17-06),
  // el match por boleta exige además misma sucursal y fecha cercana. Los matches
  // legítimos caen a 0-1 día; este margen rechaza los reciclados (>7d / otra suc).
  const BOLETA_WINDOW_DAYS = 3;

  // Índice de settlements por boleta(=OP); una OP puede repetirse en POS.
  // Llave normalizada sin ceros a la izquierda ("0515" y "515" son la misma).
  const normBoleta = (b: string) => b.replace(/^0+/, "") || "0";
  const settByBoleta = new Map<string, TransbankSale[]>();
  for (const sv of settAll) {
    if (!sv.numeroBoleta) continue;
    const k = normBoleta(sv.numeroBoleta);
    (settByBoleta.get(k) ?? settByBoleta.set(k, []).get(k)!).push(sv);
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
      for (const c of settByBoleta.get(normBoleta(op)) ?? []) {
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
      pairs.push({ pos, setts: [best], diff: bestDiff });
    } else {
      unmatchedPos.push(pos);
    }
  }

  // Pass 1.5: MULTI-BOLETA por glosa (1 POS → N settlements). Un giro pagado en
  // 2+ transacciones de tarjeta genera un POS único cuya glosa nombra ambas
  // boletas ("N OPE 4047/4048", "OP.0515-516") y N settlements separados.
  // Se cuadra automático SOLO si se cumple TODO (si algo falla, queda manual):
  //   · la glosa nombra 2+ boletas
  //   · TODAS existen como settlements libres, misma sucursal, fecha ±3d
  //   · cada boleta resuelve a UN solo candidato (sin ambigüedad)
  //   · la suma calza con el POS al peso o dentro de MULTI_TOLERANCE (recargo)
  // La suma exacta es el candado anti-falsos: 2 boletas nombradas + sucursal +
  // fecha + suma al peso no ocurre por casualidad.
  const stillUnmatched: TbkTesoreria[] = [];
  for (const pos of unmatchedPos) {
    const boletas = extractMultiBoletas(pos.glosa);
    let group: TransbankSale[] | null = null;
    if (boletas && pos.monto > 0n) {
      const picked: TransbankSale[] = [];
      let ok = true;
      for (const b of boletas) {
        const cands = (settByBoleta.get(normBoleta(b)) ?? []).filter(
          (c) =>
            !usedSett.has(c.id) &&
            !picked.some((p) => p.id === c.id) &&
            (c.sucursalId == null || c.sucursalId === pos.sucursalId) &&
            Math.abs(pos.fecha.getTime() - c.fechaVenta.getTime()) <= dayMs * BOLETA_WINDOW_DAYS,
        );
        if (cands.length !== 1) {
          ok = false; // boleta faltante o ambigua → no adivinar
          break;
        }
        picked.push(cands[0]);
      }
      if (ok && picked.length >= 2) {
        const sum = picked.reduce((acc, s) => acc + s.montoVenta, 0n);
        const ratio = Number(absB(sum - pos.monto)) / Number(pos.monto);
        if (ratio <= MULTI_TOLERANCE) group = picked;
      }
    }
    if (group) {
      for (const s of group) usedSett.add(s.id);
      const sum = group.reduce((acc, s) => acc + s.montoVenta, 0n);
      pairs.push({ pos, setts: group, diff: sum - pos.monto });
    } else {
      stillUnmatched.push(pos);
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
  for (const pos of stillUnmatched) {
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
      pairs.push({ pos, setts: [chosen], diff });
    } else {
      pairs.push({ pos, setts: [], diff: 0n });
    }
  }

  const settlementOnly = settAll.filter((s) => !usedSett.has(s.id));
  return { pairs, settlementOnly };
}
