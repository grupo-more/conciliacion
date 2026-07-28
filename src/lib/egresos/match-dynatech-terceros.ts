/**
 * Auto-match de Egresos a terceros: BankMovement OUT ↔ EGRESO de Dynatech
 * (TesoreriaMovement, tipoOperacion=EGRESO).
 *
 * CONTEXTO: algunos pagos a terceros que esperábamos por el feed /api/egresos
 * (EgresoMovement) terminaron entrando directo a /api/dynatech como EGRESO. El
 * motor principal (match.ts) ya concilia EGRESO ↔ OUT cuando el banco del
 * egreso resuelve a una cuenta y no es cross-banco; lo que NO logra cerrar cae
 * acá: cross-banco (queda SUGGESTED) o sin banco resuelto (OUT_OF_SCOPE).
 *
 * ESTE motor corre DESPUÉS del principal y SOLO auto-confirma lo seguro:
 * pares 1:1 ÚNICOS por monto exacto (con signo) dentro de ±N días — es decir,
 * el OUT tiene un único egreso candidato y ese egreso tiene un único OUT
 * candidato. Para esos crea el mismo vínculo que haría "Vincular" a mano
 * (Consolidado MANUAL + ConsolidadoLink), con matchType=AUTO_DYNATECH_EGRESO
 * para que el motor principal lo preserve (preserveManual) y sea distinguible
 * de un match hecho a mano.
 *
 * Todo lo ambiguo (varios candidatos del mismo monto) NO se toca: se resuelve
 * a mano desde el modal de la tab, que ya propone los egresos de dynatech.
 *
 * Excluye del pool de OUT, igual que la tab: los ya conciliados (ConsolidadoLink),
 * las patas de traspaso interno, las cuentas de uso parcial y los OUT en un
 * egreso MANUAL del feed operativo.
 */
import { prisma } from "@/lib/db";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import type { BankAccount, BankMovement, TesoreriaMovement } from "@prisma/client";

const DATE_WINDOW_DAYS = 7;
// Egresos cuyo Consolidado ya tiene un vínculo real: no se tocan.
const RESOLVED_STATUSES = new Set(["AUTO_MATCHED", "MANUAL"]);

export interface DynatechEgresosSummary {
  ok: boolean;
  poolOut: number;
  egresosDisponibles: number;
  autoMatched: number;
  ambiguos: number;
  ms: number;
  error?: string;
}

type BMOut = BankMovement & { account: BankAccount };
type EgresoTM = TesoreriaMovement & {
  consolidado: { id: string; status: string } | null;
};

let inFlight: Promise<DynatechEgresosSummary> | null = null;

export async function runDynatechEgresosTerceros(
  opts: { dryRun?: boolean } = {},
): Promise<DynatechEgresosSummary> {
  if (inFlight) return inFlight;
  inFlight = doRun(opts);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doRun(opts: { dryRun?: boolean }): Promise<DynatechEgresosSummary> {
  const dryRun = opts.dryRun ?? false;
  const t0 = Date.now();
  const summary: DynatechEgresosSummary = {
    ok: true, poolOut: 0, egresosDisponibles: 0, autoMatched: 0, ambiguos: 0, ms: 0,
  };

  const [allBms, egresos, entidades, manualEgresoConcs, consLinks] = await Promise.all([
    prisma.bankMovement.findMany({
      where: { direction: { in: ["IN", "OUT"] }, descartadoAt: null },
      include: { account: true },
      orderBy: { postDate: "asc" },
    }),
    prisma.tesoreriaMovement.findMany({
      // Derivados a "Acreedores tesorería": cuadre 100% manual en su tab,
      // fuera del auto-match.
      where: { tipoOperacion: "EGRESO", acreedorTesoreriaAt: null },
      include: { consolidado: { select: { id: true, status: true } } },
      orderBy: { fecha: "asc" },
    }),
    loadEntidadesInternas(prisma),
    prisma.egresoConciliacion.findMany({ where: { status: "MANUAL" }, include: { links: true } }),
    prisma.consolidadoLink.findMany({ select: { bankMovementId: true } }),
  ]);

  // OUT a excluir del pool.
  const manualBmIds = new Set<string>();
  for (const c of manualEgresoConcs) for (const l of c.links) manualBmIds.add(l.bankMovementId);
  const linkedBmIds = new Set(consLinks.map((l) => l.bankMovementId));

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
  const internalOutIds = new Set(matchMirror(forMatch, entidades).pairs.map((p) => p.out.id));

  const outPool = allBms.filter(
    (bm) =>
      bm.direction === "OUT" &&
      !linkedBmIds.has(bm.id) &&
      !internalOutIds.has(bm.id) &&
      !manualBmIds.has(bm.id) &&
      !isUsoParcialAccount(bm.account),
  ) as BMOut[];
  summary.poolOut = outPool.length;

  // Egresos de dynatech disponibles (sin vínculo real). Index por monto (con signo).
  const egresosDisp = egresos.filter(
    (e) => !(e.consolidado && RESOLVED_STATUSES.has(e.consolidado.status)),
  );
  summary.egresosDisponibles = egresosDisp.length;

  const egresosByMonto = new Map<string, EgresoTM[]>();
  for (const e of egresosDisp) {
    const k = e.monto.toString();
    (egresosByMonto.get(k) ?? egresosByMonto.set(k, []).get(k)!).push(e);
  }

  // Candidatos OUT→egresos dentro de la ventana (monto exacto con signo).
  const outCands = new Map<string, EgresoTM[]>();
  const egresoCands = new Map<string, BMOut[]>();
  const dayMs = 86400000;
  for (const bm of outPool) {
    const pool = egresosByMonto.get(bm.amount.toString()) ?? [];
    const lower = new Date(bm.postDate.getTime() - DATE_WINDOW_DAYS * dayMs);
    const upper = new Date(bm.postDate.getTime() + DATE_WINDOW_DAYS * dayMs);
    const hits = pool.filter((e) => e.fecha >= lower && e.fecha <= upper);
    if (hits.length === 0) continue;
    outCands.set(bm.id, hits);
    for (const e of hits) {
      (egresoCands.get(e.id) ?? egresoCands.set(e.id, []).get(e.id)!).push(bm);
    }
  }

  // Pares 1:1 ÚNICOS: el OUT tiene un único egreso candidato y ese egreso un
  // único OUT candidato. Solo esos se auto-confirman.
  const safePairs: Array<{ bm: BMOut; egreso: EgresoTM }> = [];
  for (const [bmId, egrs] of outCands) {
    if (egrs.length !== 1) { summary.ambiguos++; continue; }
    const egreso = egrs[0];
    const outsForEgreso = egresoCands.get(egreso.id) ?? [];
    if (outsForEgreso.length !== 1) { summary.ambiguos++; continue; }
    const bm = outPool.find((b) => b.id === bmId)!;
    safePairs.push({ bm, egreso });
  }

  if (dryRun) {
    summary.autoMatched = safePairs.length;
    summary.ms = Date.now() - t0;
    return summary;
  }

  // Persistencia: por cada par, crear/actualizar el Consolidado del egreso a
  // MANUAL y vincular el OUT (mismo efecto que manual-link N=1, M=1).
  for (const { bm, egreso } of safePairs) {
    try {
      await prisma.$transaction(async (tx) => {
        // Defensa: si el OUT quedó enganchado a otro consolidado entre la lectura
        // y ahora, no lo tocamos.
        const already = await tx.consolidadoLink.findFirst({
          where: { bankMovementId: bm.id },
          select: { id: true },
        });
        if (already) return;

        const existing = egreso.consolidado;
        const data = {
          status: "MANUAL" as const,
          matchType: "AUTO_DYNATECH_EGRESO",
          resolvedAccountId: bm.accountId,
          matchedAt: new Date(),
        };
        let consolidadoId: string;
        if (existing) {
          await tx.consolidadoLink.deleteMany({ where: { consolidadoId: existing.id } });
          const c = await tx.consolidado.update({ where: { id: existing.id }, data });
          consolidadoId = c.id;
        } else {
          const c = await tx.consolidado.create({
            data: { tesoreriaMovementId: egreso.id, ...data },
          });
          consolidadoId = c.id;
        }
        await tx.consolidadoLink.create({
          data: { consolidadoId, bankMovementId: bm.id, amountAllocated: null },
        });
      });
      summary.autoMatched++;
    } catch (e) {
      summary.ok = false;
      console.error(
        `[match-dynatech-terceros] error vinculando OUT ${bm.id.slice(0, 8)} ↔ egreso ${egreso.id.slice(0, 8)}`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  summary.ms = Date.now() - t0;
  return summary;
}
