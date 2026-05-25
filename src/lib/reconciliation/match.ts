import { prisma } from "@/lib/db";
import type { BankAccount, BankMovement, DynatechMovement, Prisma } from "@prisma/client";
import { parseGlosa, extractRuts } from "./glosa";
import {
  computeScore,
  computeHistoryPatterns,
  nameMatchRatio,
  type HistoryPatterns,
  type ScoreResult,
  type ScoreFactor,
} from "./score";

/**
 * Motor de conciliación. Empareja Ventas Dynatech con abonos bancarios.
 *
 * Casos soportados:
 *   1:1 — un Dynatech ↔ un BankMovement (caso típico)
 *   1:N — un Dynatech ↔ varios BankMovements (pagos divididos)
 *   1:0 — sin contraparte (NO_MATCH / OUT_OF_SCOPE)
 *
 * Cascada de decisión (en orden de prioridad):
 *   STEP 1  Out of scope: obs menciona banco no registrado → OUT_OF_SCOPE
 *   STEP 2  Filtrar candidatos por evidencia explícita de glosa (banco/empresa/RUT/giro)
 *   STEP 3  Aplicar hint manual de sucursal (si configurado y consistente)
 *   STEP 4  Inferencia por historial (≥70% en ≥3 confirmados)
 *   STEP 5  Buscar matches:
 *           5a. 1:1 monto exacto → AUTO_MATCHED (mismo día) o SUGGESTED (±2-7d)
 *           5b. 1:N combinaciones (2-5 partes) que sumen exacto:
 *                · Si TODAS las partes comparten RUT contraparte → SUGGESTED auto
 *                · Si comparten RUT con la glosa Dynatech → SUGGESTED auto
 *                · Si no, queda en REVIEW para selección manual
 *   STEP 6  Si nada encaja → NO_MATCH
 */

const REGISTERED_BANK_CODES = ["BCI", "SANTANDER", "INTERNACIONAL"] as const;
const HISTORY_CONFIDENCE_THRESHOLD = 0.7;
const HISTORY_MIN_SAMPLES = 3;
const MAX_SPLIT_PARTS = 5;
const MAX_CANDIDATES_FOR_COMBINATIONS = 25; // tope para evitar explosión combinatoria
const TIME_WINDOW_DAYS = 7;
const SPLIT_TIME_WINDOW_DAYS = 3; // ventana más estricta para combinaciones

/* ----------------------------- Tipos públicos ----------------------------- */

export type ReconciliationStatus =
  | "AUTO_MATCHED"
  | "SUGGESTED"
  | "REVIEW"
  | "MANUAL"
  | "NO_MATCH"
  | "OUT_OF_SCOPE";

export type ReconciliationMatchType =
  | "EXACT_SAME_DAY"
  | "EXACT_PM2"
  | "EXACT_PM7"
  | "EXACT_CUSTOMER_RUT"
  | "SPLIT_SAME_RUT"
  | "SPLIT"
  | "MANUAL"
  | null;

export interface MatchRunResult {
  processed: number;
  autoMatched: number;
  suggested: number;
  review: number;
  noMatch: number;
  outOfScope: number;
  errors: number;
}

interface RunOptions {
  reEvaluateOpenStates?: boolean;
}

interface DecisionContext {
  accounts: BankAccount[];
  accountById: Map<string, BankAccount>;
  hintByBranch: Map<number, string>;
  branchHistory: Map<number, { accountId: string; ratio: number; total: number }>;
  patterns: HistoryPatterns;
}

interface Decision {
  status: ReconciliationStatus;
  matchType: ReconciliationMatchType;
  bankMovementIds: string[];
  outOfScopeReason: string | null;
  notes: string | null;
  /** Score y desglose si vino de la cascada de score */
  score?: number | null;
}

/* ----------------------------- Punto de entrada -------------------------- */

export async function runMatching(opts: RunOptions = {}): Promise<MatchRunResult> {
  const result: MatchRunResult = {
    processed: 0,
    autoMatched: 0,
    suggested: 0,
    review: 0,
    noMatch: 0,
    outOfScope: 0,
    errors: 0,
  };

  const allAccounts = await prisma.bankAccount.findMany({
    where: {
      active: true,
      accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
    },
  });
  const accountById = new Map(allAccounts.map((a) => [a.id, a]));
  const hints = await prisma.branchAccountHint.findMany();
  const hintByBranch = new Map(hints.map((h) => [h.branchExternalId, h.accountId]));
  const branchHistory = await computeBranchHistory();
  const patterns = await computeHistoryPatterns();

  const reEvaluate = opts.reEvaluateOpenStates ?? true;

  // Re-evaluamos estados "abiertos" (no confirmados): NO_MATCH, REVIEW y
  // SUGGESTED. AUTO_MATCHED y MANUAL son confirmaciones y no se tocan —
  // si el usuario quiere re-evaluarlas, debe quitar el match primero.
  const ventas = await prisma.dynatechMovement.findMany({
    where: {
      OR: [
        { reconciliation: { is: null } },
        ...(reEvaluate
          ? [
              {
                reconciliation: {
                  is: { status: { in: ["NO_MATCH", "REVIEW", "SUGGESTED"] } },
                },
              },
            ]
          : []),
      ],
    },
    include: { reconciliation: { include: { links: true } } },
  });
  const ventasOnly = ventas.filter(isVentaMovement);

  const ctx: DecisionContext = {
    accounts: allAccounts,
    accountById,
    hintByBranch,
    branchHistory,
    patterns,
  };

  for (const v of ventasOnly) {
    try {
      // IDs de bank movements ya linkeados a ESTA reconciliation (si existe).
      // Deben excluirse del filtro "reconciliationLinks: { none: {} }" en
      // decideForMovement; si no, al re-evaluar un SUGGESTED su propio
      // candidato aparece como "ya tomado" y queda en NO_MATCH falsamente.
      const ownLinkIds =
        v.reconciliation?.links?.map((l) => l.bankMovementId) ?? [];
      const decision = await decideForMovement(v, ctx, ownLinkIds);
      await persistDecision(v.id, decision);
      result.processed++;
      switch (decision.status) {
        case "AUTO_MATCHED": result.autoMatched++; break;
        case "SUGGESTED": result.suggested++; break;
        case "REVIEW": result.review++; break;
        case "NO_MATCH": result.noMatch++; break;
        case "OUT_OF_SCOPE": result.outOfScope++; break;
      }
    } catch (e) {
      result.errors++;
      console.error("[reconciliation] error en", v.id, e instanceof Error ? e.message : e);
    }
  }

  return result;
}

/* ---------------------------- Decisión por mov --------------------------- */

async function decideForMovement(
  m: DynatechMovement,
  ctx: DecisionContext,
  /** IDs de bank movements ya linkeados a la reconciliation que estamos
   *  re-evaluando. Se exceptúan del filtro "ya tomado" — si no, un
   *  SUGGESTED re-evaluado pierde su propio candidato. */
  ownLinkIds: string[] = []
): Promise<Decision> {
  const glosa = parseGlosa(m.observation || "");

  // RUT estructurado del cliente cuando la API lo identificó (no "CLIENTE GENERICO").
  // Es evidencia muy fuerte cuando coincide con BankMovement.counterpartyRut.
  const customerRut = m.customerRut ?? null;

  // STEP 1 — Out of scope si menciona banco no registrado y NO uno registrado
  if (glosa.unregisteredBank && !glosa.bank) {
    return {
      status: "OUT_OF_SCOPE",
      matchType: null,
      bankMovementIds: [],
      outOfScopeReason: `Banco no registrado mencionado: ${glosa.unregisteredBank}`,
      notes: null,
    };
  }

  // STEP 2 — Filtrar cuentas candidatas por evidencia explícita
  let candidateAccounts = ctx.accounts.slice();
  if (glosa.bank) {
    candidateAccounts = candidateAccounts.filter((a) => a.bankCode === glosa.bank);
  }
  if (glosa.holder) {
    candidateAccounts = candidateAccounts.filter((a) => a.holderName === glosa.holder);
  }

  // STEP 3 — Hint manual de la sucursal (solo si reduce, no contradice)
  if (candidateAccounts.length !== 1) {
    const hintAccountId = ctx.hintByBranch.get(m.branchExternalId);
    if (hintAccountId) {
      const hintAccount = ctx.accountById.get(hintAccountId);
      if (hintAccount && candidateAccounts.some((a) => a.id === hintAccountId)) {
        candidateAccounts = [hintAccount];
      }
    }
  }

  // STEP 4 — Inferencia por historial
  if (candidateAccounts.length > 1) {
    const inferred = ctx.branchHistory.get(m.branchExternalId);
    if (
      inferred &&
      inferred.ratio >= HISTORY_CONFIDENCE_THRESHOLD &&
      inferred.total >= HISTORY_MIN_SAMPLES &&
      candidateAccounts.some((a) => a.id === inferred.accountId)
    ) {
      const acc = candidateAccounts.find((a) => a.id === inferred.accountId);
      if (acc) candidateAccounts = [acc];
    }
  }

  // STEP 5 — Buscar matches
  const accountIds = candidateAccounts.map((a) => a.id);
  const occDate = stripTime(m.occurredAt);

  // Excluir bank movements ya conciliados con OTRO Dynatech.
  // Pero PERMITIR los que están linkeados a ESTA misma reconciliation
  // (los pasamos en ownLinkIds desde el caller).
  const baseWhere: Prisma.BankMovementWhereInput = {
    direction: "IN",
    postDate: {
      gte: addDays(occDate, -TIME_WINDOW_DAYS),
      lte: addDays(occDate, TIME_WINDOW_DAYS + 1),
    },
    OR: [
      { reconciliationLinks: { none: {} } },
      ...(ownLinkIds.length > 0 ? [{ id: { in: ownLinkIds } }] : []),
    ],
    ...(accountIds.length > 0 ? { accountId: { in: accountIds } } : {}),
  };

  // 5a — match 1:1 (monto exacto)
  const oneToOne = await prisma.bankMovement.findMany({
    where: {
      ...baseWhere,
      amount: m.totalAmount,
    },
    orderBy: { postDate: "asc" },
  });

  // Si hay múltiples candidatos y el cliente está identificado, intentar
  // desempatar por RUT estructurado antes de mandar a REVIEW.
  let effectiveOneToOne = oneToOne;
  let rutDisambiguated = false;
  if (customerRut && oneToOne.length > 1) {
    const sameRut = oneToOne.filter((c) => c.counterpartyRut === customerRut);
    if (sameRut.length === 1) {
      effectiveOneToOne = sameRut;
      rutDisambiguated = true;
    }
  }

  if (effectiveOneToOne.length === 1) {
    const c = effectiveOneToOne[0];
    const dayDiff = Math.abs(diffDays(stripTime(c.postDate), occDate));
    const cAccount = ctx.accountById.get(c.accountId);
    const accountBankCode = cAccount?.bankCode ?? "";

    // Cálculo del score con todas las señales: monto, fecha, RUT, nombre,
    // glosa, hint, historial sucursal, patrones cliente/cajero, temporal.
    const score = computeScore({
      dyn: m,
      bank: c,
      accountBankCode,
      glosa,
      hintAppliesToThisAccount:
        ctx.hintByBranch.get(m.branchExternalId) === c.accountId,
      historyBranchMatchesThisAccount:
        ctx.branchHistory.get(m.branchExternalId)?.accountId === c.accountId,
      patterns: ctx.patterns,
    });

    const rutMatches = customerRut !== null && c.counterpartyRut === customerRut;

    // Si el score sugiere AUTO_MATCHED y el RUT coincide, usar matchType
    // EXACT_CUSTOMER_RUT (mantener compatibilidad histórica del campo).
    const matchType: ReconciliationMatchType =
      score.suggestedStatus === "AUTO_MATCHED" && rutMatches
        ? "EXACT_CUSTOMER_RUT"
        : dayDiff === 0
        ? "EXACT_SAME_DAY"
        : dayDiff <= 2
        ? "EXACT_PM2"
        : "EXACT_PM7";

    if (score.suggestedStatus === "REVIEW" || score.hardContradiction) {
      return {
        status: "REVIEW",
        matchType: null,
        bankMovementIds: [],
        outOfScopeReason: null,
        notes:
          score.hardContradiction ??
          buildScoreNote(score) +
            (rutDisambiguated
              ? ` · Desempatado por RUT entre ${oneToOne.length} candidatos`
              : ""),
        score: score.total,
      };
    }

    if (score.suggestedStatus === "NO_MATCH") {
      return {
        status: "NO_MATCH",
        matchType: null,
        bankMovementIds: [],
        outOfScopeReason: null,
        notes: `Candidato exacto disponible pero score ${score.total} insuficiente: ${buildScoreNote(score)}`,
        score: score.total,
      };
    }

    return {
      status: score.suggestedStatus,
      matchType,
      bankMovementIds: [c.id],
      outOfScopeReason: null,
      notes:
        buildScoreNote(score) +
        (rutDisambiguated
          ? ` · Desempatado por RUT entre ${oneToOne.length} candidatos`
          : ""),
      score: score.total,
    };
  }

  if (effectiveOneToOne.length > 1) {
    return {
      status: "REVIEW",
      matchType: null,
      bankMovementIds: [],
      outOfScopeReason: null,
      notes: `${effectiveOneToOne.length} candidatos 1:1 disponibles`,
    };
  }

  // 5b — buscar combinaciones (1:N) si no hay 1:1
  const splitCandidates = await prisma.bankMovement.findMany({
    where: {
      ...baseWhere,
      postDate: {
        gte: addDays(occDate, -SPLIT_TIME_WINDOW_DAYS),
        lte: addDays(occDate, SPLIT_TIME_WINDOW_DAYS + 1),
      },
      amount: { lt: m.totalAmount }, // partes deben ser menores al total
    },
    orderBy: { postDate: "asc" },
  });

  if (splitCandidates.length >= 2 && splitCandidates.length <= MAX_CANDIDATES_FOR_COMBINATIONS) {
    const combinations = findCombinationsThatSum(
      splitCandidates,
      m.totalAmount,
      MAX_SPLIT_PARTS
    );

    if (combinations.length >= 1) {
      // Buscar combinaciones donde TODAS las partes comparten un RUT
      const rutsInGlosa = new Set<string>();
      const glosaRuts = extractRuts(m.observation || "");
      glosaRuts.forEach((r) => rutsInGlosa.add(r));
      if (glosa.rut) rutsInGlosa.add(glosa.rut);
      if (customerRut) rutsInGlosa.add(customerRut);

      const sameRutCombos = combinations.filter((combo) =>
        comboSharesRut(combo, rutsInGlosa)
      );

      if (sameRutCombos.length === 1) {
        const combo = sameRutCombos[0];
        const comboRut = combo[0].counterpartyRut;
        const comboName = combo[0].counterpartyName;

        // Si el cliente Dynatech está identificado y su RUT no coincide con el
        // RUT común del combo, no sugerir automáticamente: hay contradicción.
        const splitRutContradicts =
          customerRut !== null &&
          comboRut !== null &&
          comboRut !== customerRut;

        if (splitRutContradicts) {
          return {
            status: "REVIEW",
            matchType: null,
            bankMovementIds: [],
            outOfScopeReason: null,
            notes: `Combo de ${combo.length} partes con RUT común ${comboRut} no coincide con cliente Dynatech ${customerRut}`,
          };
        }

        // Mismo principio para nombres: si el RUT no está pero el nombre común
        // del combo es claramente distinto al cliente Dynatech → REVIEW.
        const splitNameRatio = nameMatchRatio(comboName, m.customerName);
        if (splitNameRatio !== null && splitNameRatio < 0.2) {
          return {
            status: "REVIEW",
            matchType: null,
            bankMovementIds: [],
            outOfScopeReason: null,
            notes: `Combo de ${combo.length} partes a nombre de "${comboName}" no coincide con cliente Dynatech "${m.customerName}"`,
          };
        }

        // Único combo con RUT común → SUGGESTED automático
        return {
          status: "SUGGESTED",
          matchType: "SPLIT_SAME_RUT",
          bankMovementIds: combo.map((m) => m.id),
          outOfScopeReason: null,
          notes: `Pago dividido en ${combo.length} transferencias del mismo RUT`,
        };
      }

      // Múltiples combos posibles → REVIEW (usuario decide)
      return {
        status: "REVIEW",
        matchType: null,
        bankMovementIds: [],
        outOfScopeReason: null,
        notes: `${combinations.length} combinaciones posibles de pago dividido`,
      };
    }
  }

  // STEP 6 — sin nada
  return {
    status: "NO_MATCH",
    matchType: null,
    bankMovementIds: [],
    outOfScopeReason: null,
    notes:
      candidateAccounts.length === 0
        ? "Sin candidatos: ninguna cuenta registrada coincide con obs/hint/historial"
        : null,
  };
}

/* ------------------------------ Persistencia ----------------------------- */

async function persistDecision(dynatechId: string, d: Decision) {
  await prisma.$transaction(async (tx) => {
    const recon = await tx.reconciliation.upsert({
      where: { dynatechMovementId: dynatechId },
      create: {
        dynatechMovementId: dynatechId,
        status: d.status,
        matchType: d.matchType,
        outOfScopeReason: d.outOfScopeReason,
        notes: d.notes,
      },
      update: {
        status: d.status,
        matchType: d.matchType,
        outOfScopeReason: d.outOfScopeReason,
        notes: d.notes,
        matchedAt: new Date(),
      },
    });

    // Reemplazar links por completo
    await tx.reconciliationLink.deleteMany({
      where: { reconciliationId: recon.id },
    });

    if (d.bankMovementIds.length === 0) return;

    // Crear uno a uno para tolerar conflictos individuales.
    // Si un bm ya está tomado por otra reconciliation (raro pero posible por
    // race), lo saltamos y degradamos el status.
    const successful: string[] = [];
    const conflicts: string[] = [];
    for (const bmId of d.bankMovementIds) {
      try {
        await tx.reconciliationLink.create({
          data: { reconciliationId: recon.id, bankMovementId: bmId },
        });
        successful.push(bmId);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "P2002") {
          conflicts.push(bmId);
        } else {
          throw e;
        }
      }
    }

    // Si todos los conflictos: degradar a NO_MATCH para que se reintente
    // cuando el otro link se libere o cambie.
    if (successful.length === 0 && conflicts.length > 0) {
      await tx.reconciliation.update({
        where: { id: recon.id },
        data: {
          status: "NO_MATCH",
          matchType: null,
          notes: `Candidato(s) ya tomados por otras conciliaciones`,
        },
      });
    } else if (conflicts.length > 0) {
      // Match parcial — degradar a REVIEW
      await tx.reconciliation.update({
        where: { id: recon.id },
        data: {
          status: "REVIEW",
          matchType: null,
          notes: `${conflicts.length} de ${d.bankMovementIds.length} candidato(s) ya estaban tomados`,
        },
      });
    }
  });
}

/* ----------------------------- Helpers de decisión ----------------------- */

/**
 * Genera un texto resumen del score para guardar en `notes`. Lista los
 * factores que sumaron o restaron, con sus pesos. Es lo que se ve en el modal.
 */
function buildScoreNote(score: ScoreResult): string {
  const positivos = score.factors
    .filter((f) => f.weight > 0)
    .map((f) => formatFactor(f));
  const negativos = score.factors
    .filter((f) => f.weight < 0)
    .map((f) => formatFactor(f));
  const partes = [`Score ${score.total}`];
  if (positivos.length > 0) partes.push(positivos.join(", "));
  if (negativos.length > 0) partes.push(`penaliza: ${negativos.join(", ")}`);
  return partes.join(" · ");
}

function formatFactor(f: ScoreFactor): string {
  const sign = f.weight > 0 ? "+" : "";
  const base = `${f.label} ${sign}${f.weight}`;
  return f.detail ? `${base} (${f.detail})` : base;
}



function isVentaMovement(m: DynatechMovement): boolean {
  const items = m.items as Array<{ nombre?: string }> | null;
  if (!items || !Array.isArray(items) || items.length === 0) return false;
  // Una venta Dynatech tiene al menos 1 item con "Venta"
  return items.some((it) => it?.nombre?.toLowerCase().startsWith("venta"));
}

/* ------------------------ Búsqueda de combinaciones ---------------------- */

interface CandidateLite {
  id: string;
  amount: bigint;
  counterpartyRut: string | null;
  counterpartyName: string | null;
  description: string;
}

/**
 * Subset-sum: encuentra combinaciones de hasta `maxParts` movimientos que sumen
 * exactamente `target`. Usa backtracking con ordenamiento descendente y poda.
 */
function findCombinationsThatSum(
  movs: CandidateLite[],
  target: bigint,
  maxParts: number
): CandidateLite[][] {
  // Ordenar descendente por monto para poda más eficiente
  const sorted = [...movs].sort((a, b) =>
    a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0
  );

  const results: CandidateLite[][] = [];
  const current: CandidateLite[] = [];
  const MAX_RESULTS = 50; // tope defensivo

  function backtrack(start: number, remaining: bigint) {
    if (results.length >= MAX_RESULTS) return;
    if (remaining === 0n && current.length >= 2) {
      results.push([...current]);
      return;
    }
    if (remaining < 0n) return;
    if (current.length >= maxParts) return;

    for (let i = start; i < sorted.length; i++) {
      const m = sorted[i];
      if (m.amount > remaining) continue; // poda
      current.push(m);
      backtrack(i + 1, remaining - m.amount);
      current.pop();
    }
  }

  backtrack(0, target);
  return results;
}

function comboSharesRut(combo: CandidateLite[], glosaRuts: Set<string>): boolean {
  if (combo.length === 0) return false;
  const ruts = combo.map((c) => c.counterpartyRut).filter((r): r is string => !!r);
  if (ruts.length !== combo.length) return false; // alguno sin RUT, no es seguro
  // Todos comparten el mismo RUT
  const allEqual = ruts.every((r) => r === ruts[0]);
  if (!allEqual) return false;
  // Si la glosa también menciona ese RUT, doble seguridad. Si no, igualmente OK.
  if (glosaRuts.size > 0 && !glosaRuts.has(ruts[0])) {
    // RUT común entre las partes pero NO está en glosa. Aún válido — el cliente
    // pagó con sus 2 cuentas pero el cajero no anotó el RUT.
    return true;
  }
  return true;
}

/* ----------------------- Historial por sucursal -------------------------- */

async function computeBranchHistory(): Promise<
  Map<number, { accountId: string; ratio: number; total: number }>
> {
  const matches = await prisma.$queryRaw<
    Array<{
      branch_external_id: number;
      account_id: string;
      n: bigint;
    }>
  >`
    SELECT dm.branch_external_id, ba.id AS account_id, COUNT(DISTINCT r.id)::bigint AS n
    FROM "Reconciliation" r
    JOIN "DynatechMovement" dm ON r.dynatech_movement_id = dm.id
    JOIN "ReconciliationLink" rl ON rl.reconciliation_id = r.id
    JOIN "BankMovement" bm ON rl.bank_movement_id = bm.id
    JOIN "BankAccount" ba ON bm.account_id = ba.id
    WHERE r.status IN ('AUTO_MATCHED','MANUAL')
    GROUP BY dm.branch_external_id, ba.id
  `;

  const byBranch = new Map<number, { totals: Map<string, number>; total: number }>();
  for (const row of matches) {
    const entry = byBranch.get(row.branch_external_id) ?? {
      totals: new Map(),
      total: 0,
    };
    entry.totals.set(row.account_id, Number(row.n));
    entry.total += Number(row.n);
    byBranch.set(row.branch_external_id, entry);
  }

  const result = new Map<number, { accountId: string; ratio: number; total: number }>();
  for (const [branchId, { totals, total }] of byBranch.entries()) {
    let bestAccount: string | null = null;
    let bestCount = 0;
    for (const [accId, n] of totals.entries()) {
      if (n > bestCount) {
        bestAccount = accId;
        bestCount = n;
      }
    }
    if (bestAccount) {
      result.set(branchId, {
        accountId: bestAccount,
        ratio: bestCount / total,
        total,
      });
    }
  }
  return result;
}

/* ----------------------------- Date helpers ------------------------------ */

function stripTime(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/* ----------------------- Candidatos para REVIEW manual ------------------- */

export type CandidateWithScore = BankMovement & {
  account: {
    bankCode: string;
    bankName: string;
    accountNumber: string;
    displayNumber: string | null;
    holderName: string;
  };
  /** Solo para candidatos con monto exacto. null para parciales (split). */
  score: ScoreResult | null;
};

/**
 * Lista candidatos relevantes para el panel de detalle/review.
 *
 * Para candidatos con MONTO EXACTO, calcula el score completo (mismo motor
 * que el matching automático). Los parciales (para split) van sin score.
 */
export async function findCandidates(dynatechId: string): Promise<CandidateWithScore[]> {
  const m = await prisma.dynatechMovement.findUnique({
    where: { id: dynatechId },
    include: { reconciliation: { include: { links: true } } },
  });
  if (!m) return [];

  const occDate = stripTime(m.occurredAt);
  const linkedIds = m.reconciliation?.links?.map((l) => l.bankMovementId) ?? [];

  const glosa = parseGlosa(m.observation || "");
  const allAccounts = await prisma.bankAccount.findMany({
    where: {
      active: true,
      accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
    },
  });

  let filteredAccounts = allAccounts;
  if (glosa.bank) {
    filteredAccounts = filteredAccounts.filter((a) => a.bankCode === glosa.bank);
  }
  if (glosa.holder) {
    filteredAccounts = filteredAccounts.filter((a) => a.holderName === glosa.holder);
  }
  const candidateAccountIds =
    filteredAccounts.length > 0
      ? filteredAccounts.map((a) => a.id)
      : allAccounts.map((a) => a.id);

  const rows = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      postDate: {
        gte: addDays(occDate, -TIME_WINDOW_DAYS),
        lt: addDays(occDate, TIME_WINDOW_DAYS + 1),
      },
      accountId: { in: candidateAccountIds },
      amount: { lte: m.totalAmount },
      OR: [
        { reconciliationLinks: { none: {} } },
        { id: { in: linkedIds.length > 0 ? linkedIds : ["__none__"] } },
      ],
    },
    include: {
      account: {
        select: {
          bankCode: true,
          bankName: true,
          holderName: true,
          accountNumber: true,
          displayNumber: true,
        },
      },
    },
  });

  // Cargar contexto necesario para scoring (patrones + hints + historial)
  const [hints, branchHistory, patterns] = await Promise.all([
    prisma.branchAccountHint.findMany({ where: { branchExternalId: m.branchExternalId } }),
    computeBranchHistory(),
    computeHistoryPatterns(),
  ]);
  const hintAccountId = hints[0]?.accountId ?? null;
  const branchHistoryAccountId =
    branchHistory.get(m.branchExternalId)?.accountId ?? null;

  // Calcular score por candidato (solo para exactos)
  const withScore: CandidateWithScore[] = rows.map((c) => {
    const isExact = c.amount === m.totalAmount;
    let score: ScoreResult | null = null;
    if (isExact) {
      score = computeScore({
        dyn: m,
        bank: c,
        accountBankCode: c.account.bankCode,
        glosa,
        hintAppliesToThisAccount: hintAccountId === c.accountId,
        historyBranchMatchesThisAccount: branchHistoryAccountId === c.accountId,
        patterns,
      });
    }
    return { ...c, score };
  });

  // Ordenar: 1) exactos primero, 2) score desc dentro de exactos,
  // 3) cercanía de fecha, 4) monto desc
  const target = m.totalAmount;
  const occMs = occDate.getTime();
  return withScore.sort((a, b) => {
    const aExact = a.amount === target ? 0 : 1;
    const bExact = b.amount === target ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.score && b.score && a.score.total !== b.score.total) {
      return b.score.total - a.score.total;
    }
    const aDayDiff = Math.abs(a.postDate.getTime() - occMs);
    const bDayDiff = Math.abs(b.postDate.getTime() - occMs);
    if (aDayDiff !== bDayDiff) return aDayDiff - bDayDiff;
    return a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0;
  });
}
