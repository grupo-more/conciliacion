/**
 * Cómputo del reporte "Banco sin conciliar". Compartido entre el detalle
 * (/api/reportes/banco-sin-conciliar) y el resumen cruzado (/api/reportes/
 * overview) para que ambos cuenten EXACTAMENTE lo mismo.
 *
 * "Conciliado / resuelto" no es solo el link del motor. Un BankMovement sale de
 * la brecha si:
 *   - tiene ConsolidadoLink a un Consolidado AUTO_MATCHED/MANUAL (motor), o
 *   - es un abono Transbank (resuelto en la tab "Abono Transbank"), o
 *   - es una pata de un par de traspaso interno OUT↔IN (tab "Traspasos internos").
 *
 * Los huérfanos de traspaso (OUT/IN internos sin espejo) SÍ son brecha.
 */
import { prisma } from "@/lib/db";
import { detectInterno, loadEntidadesInternas } from "@/lib/internos/detect";
import { isTransbank } from "@/lib/transbank/detect";
import { getDifMenorSettings, isDifMenor } from "@/lib/dif-menor/detect";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import {
  agingBucket,
  bankTag,
  AGING_BUCKETS,
  CONCILIADO_STATUSES,
  type AgingBucket,
  type BankTag,
} from "./classify";

const TAKE = 10000;

export interface BancoFilters {
  accountId?: string | null;
  direction?: string | null; // "IN" | "OUT"
  tag?: BankTag | null;
}

export interface BancoRow {
  id: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  direction: string;
  accountId: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  tag: BankTag;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  description: string | null;
}

export async function computeBancoSinConciliar(
  from: Date,
  to: Date,
  filters: BancoFilters = {},
) {
  const entidades = await loadEntidadesInternas(prisma);
  const now = new Date();
  const conciliado = new Set<string>(CONCILIADO_STATUSES);
  const { threshold: difThreshold } = await getDifMenorSettings();

  // Traemos TODO el rango (sin filtros de fila) para: (a) correr matchMirror
  // sobre el universo completo, (b) clasificar de forma estable.
  const all = await prisma.bankMovement.findMany({
    // Excluye descartados: no corresponden al sistema (no cuentan como sin
    // conciliar ni aparecen como pendientes de asiento manual). Excluye también
    // los manuales/ficticios: existen solo para conciliar su Tesorería, no son
    // cartola real y no cuentan en saldos ni en "sin conciliar".
    where: { postDate: { gte: from, lt: to }, descartadoAt: null, manual: false },
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
          holderRut: true,
        },
      },
      consolidadoLinks: {
        select: { consolidado: { select: { status: true } } },
      },
      // Conciliación contra gasto operativo (Egresos a terceros).
      egresoConciliacionLinks: {
        select: { conciliacion: { select: { status: true } } },
      },
      // Asiento manual generado (módulo "Asientos manuales").
      asientoManual: { select: { estado: true } },
    },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    take: TAKE,
  });

  // Pares de traspaso interno → set de bankMovementIds resueltos.
  const forMatch: BankMovementForMatch[] = all.map((bm) => ({
    id: bm.id,
    accountId: bm.accountId,
    postDate: bm.postDate,
    amount: bm.amount,
    direction: bm.direction,
    description: bm.description,
    counterpartyName: bm.counterpartyName,
    counterpartyRut: bm.counterpartyRut,
    account: {
      id: bm.account.id,
      bankName: bm.account.bankName,
      holderName: bm.account.holderName,
      holderRut: bm.account.holderRut,
      accountNumber: bm.account.accountNumber,
      displayNumber: bm.account.displayNumber,
    },
  }));
  const mirror = matchMirror(forMatch, entidades);
  const pairedIds = new Set<string>();
  for (const p of mirror.pairs) {
    pairedIds.add(p.out.id);
    pairedIds.add(p.in.id);
  }

  // Acumuladores
  const rows: BancoRow[] = [];
  const accountSet = new Map<string, string>();
  let count = 0;
  let montoAbs = 0n;
  let resTransbankCount = 0;
  let resTransbankMonto = 0n;
  let resTraspasoCount = 0;
  let resTraspasoMonto = 0n;
  let resEgresoCount = 0;
  let resEgresoMonto = 0n;
  let resDifMenorCount = 0;
  let resDifMenorMonto = 0n;
  let resAsientoCount = 0;
  let resAsientoMonto = 0n;
  let noRelevanteCount = 0;
  let noRelevanteMonto = 0n;
  const porDireccion = mkAmountMap(["IN", "OUT"]);
  const porTag = mkAmountMap<BankTag>([
    "interno",
    "transbank",
    "comision",
    "sin_clasificar",
  ]);
  const porAging = mkAmountMap<AgingBucket>([...AGING_BUCKETS]);
  const porBanco = new Map<string, { label: string; count: number; monto: bigint }>();

  for (const bm of all) {
    const abs = bm.amount < 0n ? -bm.amount : bm.amount;

    // 1) Conciliado por el motor (link AUTO/MANUAL) → fuera de la brecha.
    const linkedOk = bm.consolidadoLinks.some(
      (l) => l.consolidado && conciliado.has(l.consolidado.status),
    );
    if (linkedOk) continue;

    // 2) Abono Transbank → resuelto en su tab.
    if (isTransbank(bm)) {
      resTransbankCount++;
      resTransbankMonto += abs;
      continue;
    }

    // 3) Par de traspaso interno → resuelto en Traspasos internos. Se chequea
    // ANTES de uso parcial: en la cuenta de uso parcial (MORE CAPITAL) los
    // traspasos SON lo relevante, así que cuentan como traspaso, no como "no
    // relevante". El resto de esa cuenta cae en el paso siguiente.
    if (pairedIds.has(bm.id)) {
      resTraspasoCount++;
      resTraspasoMonto += abs;
      continue;
    }

    // 4) Cuenta de uso parcial: el resto (no-traspaso) es "no relevante" →
    // fuera de la brecha.
    if (isUsoParcialAccount(bm.account)) {
      noRelevanteCount++;
      noRelevanteMonto += abs;
      continue;
    }

    // 5) Egreso a tercero conciliado (OUT ↔ gasto operativo) → resuelto en su tab.
    const linkedEgreso = bm.egresoConciliacionLinks.some(
      (l) => l.conciliacion && conciliado.has(l.conciliacion.status),
    );
    if (linkedEgreso) {
      resEgresoCount++;
      resEgresoMonto += abs;
      continue;
    }

    // 6) Dif menor (|monto| ≤ umbral, IN u OUT) → tiene asiento propio en
    // "Dif menor" (toggle Ingresos/Egresos).
    if (isDifMenor(bm, difThreshold)) {
      resDifMenorCount++;
      resDifMenorMonto += abs;
      continue;
    }

    // 7) Asiento manual GENERADO o EMITIDO (módulo "Asientos manuales") →
    // resuelto. EMITIDO = generado + documento ya ingresado a gestión; sigue
    // igual de resuelto (si no, emitir lo devolvería a "pendientes").
    if (bm.asientoManual?.estado === "GENERADO" || bm.asientoManual?.estado === "EMITIDO") {
      resAsientoCount++;
      resAsientoMonto += abs;
      continue;
    }

    // 7) Brecha real. Clasificar y aplicar filtros de fila.
    const esInterno = detectInterno(bm, entidades) !== null;
    const tag = bankTag(esInterno, bm.description, bm.counterpartyName);

    // Facets: cuentas con brecha (antes de filtrar por cuenta/dirección/tag).
    const cuentaNumero = bm.account.displayNumber || bm.account.accountNumber;
    const cuentaLabel = [bm.account.bankName, bm.account.holderName, cuentaNumero]
      .filter((s) => s && s.trim().length > 0)
      .join(" · ");
    accountSet.set(bm.account.id, cuentaLabel);

    if (filters.accountId && bm.account.id !== filters.accountId) continue;
    if (
      (filters.direction === "IN" || filters.direction === "OUT") &&
      bm.direction !== filters.direction
    )
      continue;
    if (filters.tag && tag !== filters.tag) continue;

    const { days, bucket } = agingBucket(bm.postDate, now);

    count++;
    montoAbs += abs;
    bump(porDireccion, bm.direction, abs);
    bump(porTag, tag, abs);
    bump(porAging, bucket, abs);
    const bk = porBanco.get(bm.account.id) ?? {
      label: cuentaLabel,
      count: 0,
      monto: 0n,
    };
    bk.count++;
    bk.monto += abs;
    porBanco.set(bm.account.id, bk);

    rows.push({
      id: bm.id,
      fecha: bm.postDate.toISOString(),
      aging: days,
      agingBucket: bucket,
      direction: bm.direction,
      accountId: bm.account.id,
      bankName: bm.account.bankName,
      holderName: bm.account.holderName,
      accountNumber: cuentaNumero,
      monto: abs.toString(),
      tag,
      counterpartyName: bm.counterpartyName,
      counterpartyRut: bm.counterpartyRut,
      description: bm.description,
    });
  }

  return {
    truncated: all.length === TAKE,
    rows,
    resumen: {
      count,
      monto: montoAbs.toString(),
      resueltos: {
        transbank: { count: resTransbankCount, monto: resTransbankMonto.toString() },
        traspasos: { count: resTraspasoCount, monto: resTraspasoMonto.toString() },
        egresos: { count: resEgresoCount, monto: resEgresoMonto.toString() },
        difMenor: { count: resDifMenorCount, monto: resDifMenorMonto.toString() },
        asientoManual: { count: resAsientoCount, monto: resAsientoMonto.toString() },
        noRelevante: { count: noRelevanteCount, monto: noRelevanteMonto.toString() },
      },
      porDireccion: dumpAmountMap(porDireccion),
      porTag: dumpAmountMap(porTag),
      porAging: dumpAmountMap(porAging),
      porBanco: [...porBanco.values()]
        .map((b) => ({ label: b.label, count: b.count, monto: b.monto.toString() }))
        .sort((a, b) => Number(BigInt(b.monto) - BigInt(a.monto))),
    },
    facets: {
      accounts: [...accountSet.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  };
}

/* ============================== Helpers ============================== */

function mkAmountMap<K extends string>(
  keys: K[],
): Map<K, { count: number; monto: bigint }> {
  const m = new Map<K, { count: number; monto: bigint }>();
  for (const k of keys) m.set(k, { count: 0, monto: 0n });
  return m;
}

function bump<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
  key: K,
  abs: bigint,
) {
  const e = m.get(key);
  if (!e) return;
  e.count++;
  e.monto += abs;
}

function dumpAmountMap<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
): Record<K, { count: number; monto: string }> {
  const out = {} as Record<K, { count: number; monto: string }>;
  for (const [k, v] of m.entries()) {
    out[k] = { count: v.count, monto: v.monto.toString() };
  }
  return out;
}
