/**
 * Motor de conciliación de Egresos a terceros: EgresoMovement (gastos
 * operativos de Dynatech: arriendos, finiquitos, honorarios…) ↔ BankMovement
 * OUT a terceros.
 *
 * Espeja el motor de Consolidados (match.ts) pero del lado egresos:
 *   - ancla = EgresoMovement; candidatos = BankMovement OUT.
 *   - una pasada que wipea no-MANUAL y reconstruye con asignación bipartita
 *     greedy por score. Un BM OUT va a un solo egreso.
 *
 * El recipiente del egreso viene embebido en la glosa (ej. "PAGO ARRIENDO
 * SUECIA/VALENTINA GONZALEZ JUN-26"); se matchea por monto exacto + fecha +
 * nombre (token de la glosa en counterpartyName del banco) + RUT si lo hay.
 *
 * Excluye del pool de OUT: los ya conciliados contra Tesorería (ConsolidadoLink),
 * las patas de traspaso interno (matchMirror), las cuentas de uso parcial, y los
 * que ya están en un egreso MANUAL.
 */
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import type { BankAccount, BankMovement, EgresoMovement } from "@prisma/client";

const DATE_WINDOW_DAYS = 7;
const THRESHOLDS = { AUTO_MATCHED: 50, SUGGESTED: 30 } as const;
const WEIGHTS = {
  amount_exact: 30,
  same_day: 25,
  diff_1d: 18,
  diff_2d: 12,
  diff_3d: 8,
  diff_4_7d: 4,
  name_match: 25,
  rut_match: 15,
} as const;

const STOPWORDS = new Set([
  "PAGO", "PAGOS", "ARRIENDO", "ARRDO", "ARRENDAMIENTO", "BODEGA", "LOCAL",
  "DEPTO", "DEPARTAMENTO", "GASTOS", "COMUNES", "FINIQUITO", "FINIQUTO",
  "FINIQUITOS", "PRORRAT", "PRORRATEO", "SALDO", "HONORARIOS", "SERVICIOS",
  "SERVICIO", "PROVEEDORES", "PROVEEDOR", "ASESORIA", "FACT", "FACTURA",
  "TRANSF", "TRANSFERENCIA", "INTERNET", "ABONO", "DIF", "PDTE", "PENDIENTE",
  "MES", "ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT",
  "NOV", "DIC", "SPA", "LTDA", "LIMITADA", "DE", "DEL", "LA", "EL", "Y",
]);

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** Tokens de nombre del recipiente, de la glosa del egreso. Prioriza lo que
 *  viene después de "/" (suele ser el nombre); si no hay, toda la glosa. */
function recipientTokens(glosa: string | null | undefined): string[] {
  if (!glosa) return [];
  const seg = glosa.includes("/") ? glosa.split("/").slice(1).join(" ") : glosa;
  return stripDiacritics(seg)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 4 && !/^[0-9]+$/.test(t) && !STOPWORDS.has(t));
}

function rutFromText(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2}\.?\d{3}\.?\d{3}-?[\dKk])/);
  return m ? normalizeRut(m[1]) : null;
}

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

type BMOut = BankMovement & { account: BankAccount };

export interface ScoreFactor {
  key: keyof typeof WEIGHTS;
  label: string;
  weight: number;
}

function calendarDaysDelta(e: EgresoMovement, bm: BankMovement): number {
  const a = new Date(e.fecha.getFullYear(), e.fecha.getMonth(), e.fecha.getDate());
  const b = new Date(bm.postDate.getFullYear(), bm.postDate.getMonth(), bm.postDate.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function scoreEgresoPair(e: EgresoMovement, bm: BMOut): {
  score: number;
  factors: ScoreFactor[];
  deltaDays: number;
} {
  const factors: ScoreFactor[] = [];
  factors.push({ key: "amount_exact", label: "Monto exacto", weight: WEIGHTS.amount_exact });

  const delta = calendarDaysDelta(e, bm);
  const abs = Math.abs(delta);
  if (abs === 0) factors.push({ key: "same_day", label: "Mismo día", weight: WEIGHTS.same_day });
  else if (abs === 1) factors.push({ key: "diff_1d", label: "±1 día", weight: WEIGHTS.diff_1d });
  else if (abs === 2) factors.push({ key: "diff_2d", label: "±2 días", weight: WEIGHTS.diff_2d });
  else if (abs === 3) factors.push({ key: "diff_3d", label: "±3 días", weight: WEIGHTS.diff_3d });
  else if (abs <= 7) factors.push({ key: "diff_4_7d", label: `±${abs} días`, weight: WEIGHTS.diff_4_7d });

  // Nombre: token del recipiente (glosa) en counterpartyName del banco.
  const cpName = stripDiacritics(bm.counterpartyName ?? "");
  if (cpName) {
    const tok = recipientTokens(e.glosa).find((t) => cpName.includes(t));
    if (tok) factors.push({ key: "name_match", label: `Nombre "${tok}" en banco`, weight: WEIGHTS.name_match });
  }

  // RUT: en glosa egreso vs counterparty del banco.
  const eRut = rutFromText(e.glosa);
  const bRut = normalizeRut(bm.counterpartyRut) || rutFromText(bm.description) || rutFromText(bm.counterpartyName);
  if (eRut && bRut && eRut === bRut) {
    factors.push({ key: "rut_match", label: "RUT coincide", weight: WEIGHTS.rut_match });
  }

  const total = factors.reduce((s, f) => s + f.weight, 0);
  return { score: total, factors, deltaDays: delta };
}

function statusForScore(score: number): "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" {
  if (score >= THRESHOLDS.AUTO_MATCHED) return "AUTO_MATCHED";
  if (score >= THRESHOLDS.SUGGESTED) return "SUGGESTED";
  return "REVIEW";
}

interface Candidate {
  egresoId: string;
  bm: BMOut;
  score: number;
  factors: ScoreFactor[];
  status: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW";
  deltaAbs: number;
}

export interface EgresosRunSummary {
  ok: boolean;
  processed: number;
  autoMatched: number;
  suggested: number;
  noMatch: number;
  errors: number;
  ms: number;
}

let inFlight: Promise<EgresosRunSummary> | null = null;

export async function runEgresosTerceros(
  opts: { dryRun?: boolean; preserveManual?: boolean } = {},
): Promise<EgresosRunSummary> {
  if (inFlight) return inFlight;
  inFlight = doRun(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doRun(opts: { dryRun?: boolean; preserveManual?: boolean }): Promise<EgresosRunSummary> {
  const preserveManual = opts.preserveManual ?? true;
  const dryRun = opts.dryRun ?? false;
  const t0 = Date.now();
  const summary: EgresosRunSummary = {
    ok: true, processed: 0, autoMatched: 0, suggested: 0, noMatch: 0, errors: 0, ms: 0,
  };

  const [egresos, allBms, entidades, manualConcs] = await Promise.all([
    prisma.egresoMovement.findMany({ orderBy: { fecha: "asc" } }),
    prisma.bankMovement.findMany({
      where: { direction: { in: ["IN", "OUT"] }, descartadoAt: null },
      include: { account: true },
      orderBy: { postDate: "asc" },
    }),
    loadEntidadesInternas(prisma),
    preserveManual
      ? prisma.egresoConciliacion.findMany({ where: { status: "MANUAL" }, include: { links: true } })
      : Promise.resolve([]),
  ]);

  // BMs ya usados por un egreso MANUAL (no se tocan) y egresos MANUAL (no se reprocesan).
  const manualBmIds = new Set<string>();
  const manualEgresoIds = new Set<string>();
  for (const c of manualConcs) {
    manualEgresoIds.add(c.egresoMovementId);
    for (const l of c.links) manualBmIds.add(l.bankMovementId);
  }

  // OUT ya conciliados contra Tesorería (ConsolidadoLink).
  const tesoreriaLinked = new Set(
    (await prisma.consolidadoLink.findMany({ select: { bankMovementId: true } })).map((l) => l.bankMovementId),
  );

  // Patas OUT de traspasos internos (matchMirror sobre IN+OUT del universo).
  const forMatch: BankMovementForMatch[] = allBms.map((bm) => ({
    id: bm.id, accountId: bm.accountId, postDate: bm.postDate, amount: bm.amount,
    direction: bm.direction, description: bm.description,
    counterpartyName: bm.counterpartyName, counterpartyRut: bm.counterpartyRut,
    account: {
      id: bm.account.id, bankName: bm.account.bankName, holderName: bm.account.holderName,
      holderRut: bm.account.holderRut, accountNumber: bm.account.accountNumber,
      displayNumber: bm.account.displayNumber,
    },
  }));
  const mirror = matchMirror(forMatch, entidades);
  const internalOutIds = new Set(mirror.pairs.map((p) => p.out.id));

  // Pool de OUT candidatos.
  const outPool = allBms.filter(
    (bm) =>
      bm.direction === "OUT" &&
      !tesoreriaLinked.has(bm.id) &&
      !internalOutIds.has(bm.id) &&
      !manualBmIds.has(bm.id) &&
      !isUsoParcialAccount(bm.account),
  ) as BMOut[];

  // Index OUT por monto absoluto para acelerar.
  const outByAmt = new Map<string, BMOut[]>();
  for (const bm of outPool) {
    const k = absBig(bm.amount).toString();
    (outByAmt.get(k) ?? outByAmt.set(k, []).get(k)!).push(bm);
  }

  const processable = egresos.filter((e) => !manualEgresoIds.has(e.id));
  summary.processed = processable.length;

  // Generar candidatos.
  const allCands: Candidate[] = [];
  const dayMs = 86400000;
  for (const e of processable) {
    const lower = new Date(e.fecha.getTime() - DATE_WINDOW_DAYS * dayMs);
    const upper = new Date(e.fecha.getTime() + DATE_WINDOW_DAYS * dayMs);
    const pool = outByAmt.get(absBig(e.monto).toString()) ?? [];
    for (const bm of pool) {
      if (bm.postDate < lower || bm.postDate > upper) continue;
      const { score, factors, deltaDays } = scoreEgresoPair(e, bm);
      const status = statusForScore(score);
      if (status === "REVIEW") continue; // muy débil (solo monto, fecha lejana) → no proponer
      allCands.push({ egresoId: e.id, bm, score, factors, status, deltaAbs: Math.abs(deltaDays) });
    }
  }

  // Asignación bipartita greedy (score desc, luego delta asc, luego id estable).
  allCands.sort((a, b) =>
    b.score - a.score || a.deltaAbs - b.deltaAbs || a.egresoId.localeCompare(b.egresoId),
  );
  const assignedEgreso = new Set<string>();
  const assignedBm = new Set<string>();
  const assignedByEgreso = new Map<string, Candidate>();
  for (const c of allCands) {
    if (assignedEgreso.has(c.egresoId) || assignedBm.has(c.bm.id)) continue;
    assignedEgreso.add(c.egresoId);
    assignedBm.add(c.bm.id);
    assignedByEgreso.set(c.egresoId, c);
  }

  if (dryRun) {
    for (const e of processable) {
      const c = assignedByEgreso.get(e.id);
      if (!c) summary.noMatch++;
      else if (c.status === "AUTO_MATCHED") summary.autoMatched++;
      else summary.suggested++;
    }
    summary.ms = Date.now() - t0;
    return summary;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.egresoConciliacionLink.deleteMany({
          where: { conciliacion: preserveManual ? { status: { not: "MANUAL" } } : {} },
        });
        await tx.egresoConciliacion.deleteMany({
          where: preserveManual ? { status: { not: "MANUAL" } } : {},
        });

        for (const e of processable) {
          const c = assignedByEgreso.get(e.id);
          if (!c) {
            await tx.egresoConciliacion.create({
              data: { egresoMovementId: e.id, status: "NO_MATCH", matchType: null },
            });
            summary.noMatch++;
            continue;
          }
          const conc = await tx.egresoConciliacion.create({
            data: {
              egresoMovementId: e.id,
              status: c.status,
              matchType: c.status === "AUTO_MATCHED" ? "MANUAL_AMOUNT_NAME" : null,
              score: Math.round(c.score),
              proposalJson:
                c.status === "AUTO_MATCHED" ? undefined : { bankMovementIds: [c.bm.id] },
            },
          });
          if (c.status === "AUTO_MATCHED") {
            await tx.egresoConciliacionLink.create({
              data: { conciliacionId: conc.id, bankMovementId: c.bm.id },
            });
            summary.autoMatched++;
          } else {
            summary.suggested++;
          }
        }
      },
      { timeout: 60000 },
    );
  } catch (e) {
    summary.errors++;
    summary.ok = false;
    console.error("[egresos-terceros] error en transaccion", e instanceof Error ? e.message : e);
  }

  summary.ms = Date.now() - t0;
  return summary;
}
