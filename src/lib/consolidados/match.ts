/**
 * Motor de matching para Consolidados (Tesoreria ↔ BankMovement).
 *
 * Diferencias con el motor de Reconciliation (Dynatech):
 *  - Tesoreria trae el campo `banco` resuelto desde la API, así que NO
 *    necesitamos heurísticas para detectar el banco (parser de glosa,
 *    branch hints, historial). Resolvemos cuenta bancaria por fuzzy
 *    match directo entre tesoreria.banco y BankAccount.
 *  - Si `esExcepcion === true` → REVIEW automático (la API ya marcó el
 *    movimiento como sospechoso).
 *  - V1 solo soporta 1:1. Splits 1:N quedan para una iteración futura
 *    si los datos reales lo justifican.
 */
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";
import type {
  BankAccount,
  BankMovement,
  TesoreriaMovement,
} from "@prisma/client";

/* ============================== Constantes ============================== */

const DATE_WINDOW_DAYS = 7; // ventana ±N días para buscar candidatos

const THRESHOLDS = {
  AUTO_MATCHED: 80,
  SUGGESTED: 60,
  REVIEW: 40,
} as const;

const WEIGHTS = {
  amount_exact: 30, // siempre, es precondición de candidato
  same_day: 20,
  diff_1d: 15,
  diff_2d: 10,
  diff_3_7d: 5,
  rut_match: 35,
  rut_contradicts: -100,
  name_high: 20,
  name_mid: 10,
  temporal_after: 5, // abono posterior a la venta (lógico)
  temporal_before: -15, // abono anterior a la venta (sospechoso)
} as const;

/* ================================ Tipos ================================ */

export interface ScoreFactor {
  key: keyof typeof WEIGHTS;
  label: string;
  weight: number;
  detail?: string;
}

export interface ScoredCandidate {
  bankMovement: BankMovement & { account: BankAccount };
  score: number;
  factors: ScoreFactor[];
}

export interface MatchDecision {
  status: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" | "NO_MATCH" | "OUT_OF_SCOPE";
  matchType:
    | "EXACT_SAME_DAY"
    | "EXACT_PM3"
    | "EXACT_PM7"
    | "SPLIT_SAME_RUT"
    | "SPLIT"
    | "MANUAL"
    | null;
  score: number | null;
  resolvedAccountId: string | null;
  bestCandidateId: string | null;
  alternatives: string[];
  outOfScopeReason: string | null;
}

export interface RunSummary {
  ok: boolean;
  processed: number;
  autoMatched: number;
  suggested: number;
  review: number;
  noMatch: number;
  outOfScope: number;
  errors: number;
  ms: number;
}

/* ============================ Bank resolution ============================ */

/**
 * Normaliza un string de banco para comparación tolerante.
 * "Santander ME" → "SANTANDERME"
 * "  BCI  ME  "  → "BCIME"
 */
function normalizeBankString(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Mapeo de tokens conocidos en el campo `banco` de Tesoreria a bankCode.
 * Si la API agrega bancos nuevos, hay que extender aquí o usar alias en
 * BankAccount para que matchee solo.
 */
const BANK_CODE_TOKENS: Array<{ token: string; bankCode: string }> = [
  { token: "SANTANDER", bankCode: "SANTANDER" },
  { token: "BCI", bankCode: "BCI" },
  { token: "INTERNACIONAL", bankCode: "INTERNACIONAL" },
];

/**
 * Dado el string `banco` de Tesoreria (ej "Santander ME"), retorna las
 * cuentas candidatas. Estrategia:
 *  1. Identificar bankCode por token contenido.
 *  2. Filtrar cuentas activas con ese bankCode.
 *  3. Si Tesoreria.banco tiene un sufijo (ej "ME", "BAGO"), priorizar
 *     cuentas cuyo alias/purpose/bankName lo mencione.
 *  4. Si nada calza, devolver todas las cuentas activas del bankCode
 *     como candidatas (deja que el filtrado por monto+fecha desambigüe).
 */
export async function resolveCandidateAccounts(
  banco: string | null | undefined
): Promise<BankAccount[]> {
  if (!banco) return [];
  const norm = normalizeBankString(banco);

  // 1. Detectar bankCode
  const codeMatch = BANK_CODE_TOKENS.find((t) => norm.includes(t.token));
  if (!codeMatch) return [];

  const accounts = await prisma.bankAccount.findMany({
    where: { bankCode: codeMatch.bankCode, active: true },
  });
  if (accounts.length === 0) return [];
  if (accounts.length === 1) return accounts;

  // 2. Desambiguar por alias/purpose/bankName si hay varias del mismo bankCode
  const suffix = norm.replace(codeMatch.token, "");
  if (!suffix) return accounts;

  const prioritized = accounts.filter((a) => {
    const haystack = normalizeBankString(
      `${a.alias ?? ""} ${a.purpose ?? ""} ${a.bankName} ${a.displayNumber ?? ""}`
    );
    return haystack.includes(suffix);
  });

  return prioritized.length > 0 ? prioritized : accounts;
}

/* ============================ Name similarity ============================ */

/**
 * Similitud entre dos nombres de personas/empresas. Devuelve 0..1.
 * Estrategia: tokenizar, normalizar, calcular Jaccard sobre tokens ≥3 chars.
 */
function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const tok = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((t) => t.length >= 3);
  const ta = new Set(tok(a));
  const tb = new Set(tok(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* =============================== Scoring =============================== */

export function scoreCandidate(
  t: TesoreriaMovement,
  b: BankMovement
): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [];

  // 1. Monto exacto (siempre presente, es precondición)
  factors.push({
    key: "amount_exact",
    label: "Monto exacto",
    weight: WEIGHTS.amount_exact,
  });

  // 2. Distancia de fechas
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaMs = b.postDate.getTime() - t.fecha.getTime();
  const deltaDays = Math.round(deltaMs / dayMs);
  const absDays = Math.abs(deltaDays);
  if (absDays === 0) {
    factors.push({ key: "same_day", label: "Mismo día", weight: WEIGHTS.same_day });
  } else if (absDays === 1) {
    factors.push({ key: "diff_1d", label: "±1 día", weight: WEIGHTS.diff_1d });
  } else if (absDays === 2) {
    factors.push({ key: "diff_2d", label: "±2 días", weight: WEIGHTS.diff_2d });
  } else if (absDays <= 7) {
    factors.push({
      key: "diff_3_7d",
      label: `±${absDays} días`,
      weight: WEIGHTS.diff_3_7d,
    });
  }

  // 3. Coherencia temporal (abono debe ser igual o posterior a la venta)
  if (deltaDays >= 0 && absDays > 0) {
    factors.push({
      key: "temporal_after",
      label: "Abono posterior a venta",
      weight: WEIGHTS.temporal_after,
    });
  } else if (deltaDays < 0) {
    factors.push({
      key: "temporal_before",
      label: "Abono anterior a venta",
      weight: WEIGHTS.temporal_before,
    });
  }

  // 4. RUT
  const tRut = normalizeRut(t.clienteRut);
  const bRut = normalizeRut(b.counterpartyRut);
  if (tRut && bRut) {
    if (tRut === bRut) {
      factors.push({ key: "rut_match", label: "RUT coincide", weight: WEIGHTS.rut_match });
    } else {
      factors.push({
        key: "rut_contradicts",
        label: `RUT distinto (${tRut} vs ${bRut})`,
        weight: WEIGHTS.rut_contradicts,
      });
    }
  }

  // 5. Nombre
  const nameSim = nameSimilarity(t.clienteName, b.counterpartyName);
  if (nameSim >= 0.5) {
    factors.push({
      key: "name_high",
      label: `Nombre similar (${nameSim.toFixed(2)})`,
      weight: WEIGHTS.name_high,
    });
  } else if (nameSim >= 0.3) {
    factors.push({
      key: "name_mid",
      label: `Nombre parcial (${nameSim.toFixed(2)})`,
      weight: WEIGHTS.name_mid,
    });
  }

  const total = factors.reduce((sum, f) => sum + f.weight, 0);
  return { score: total, factors };
}

/* ============================== Match logic ============================== */

/**
 * Decide el match para un movimiento Tesoreria contra sus candidatos.
 */
export function decideMatch(
  t: TesoreriaMovement,
  accounts: BankAccount[],
  candidates: Array<BankMovement & { account: BankAccount }>
): MatchDecision {
  // No se pudo resolver cuenta → OUT_OF_SCOPE
  if (accounts.length === 0) {
    return {
      status: "OUT_OF_SCOPE",
      matchType: null,
      score: null,
      resolvedAccountId: null,
      bestCandidateId: null,
      alternatives: [],
      outOfScopeReason: t.banco
        ? `No se pudo resolver cuenta bancaria desde "${t.banco}"`
        : "Tesoreria sin banco asignado",
    };
  }

  // esExcepcion=true → REVIEW directo aunque haya candidatos. La API ya marcó
  // este movimiento como sospechoso y debe revisarlo un humano.
  if (t.esExcepcion) {
    const best = candidates[0];
    return {
      status: "REVIEW",
      matchType: null,
      score: null,
      resolvedAccountId: accounts.length === 1 ? accounts[0].id : null,
      bestCandidateId: best?.id ?? null,
      alternatives: candidates.slice(1, 6).map((c) => c.id),
      outOfScopeReason: null,
    };
  }

  // Sin candidatos por monto+fecha → NO_MATCH
  if (candidates.length === 0) {
    return {
      status: "NO_MATCH",
      matchType: null,
      score: null,
      resolvedAccountId: accounts.length === 1 ? accounts[0].id : null,
      bestCandidateId: null,
      alternatives: [],
      outOfScopeReason: null,
    };
  }

  // Scorear todos y ordenar
  const scored: ScoredCandidate[] = candidates
    .map((c) => {
      const { score, factors } = scoreCandidate(t, c);
      return { bankMovement: c, score, factors };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const matchType = inferMatchType(t, best.bankMovement);

  // Status según score del best
  let status: MatchDecision["status"];
  if (best.score >= THRESHOLDS.AUTO_MATCHED) {
    // Si hay un segundo muy cercano, mejor SUGGESTED para revisión
    if (scored.length > 1 && scored[1].score >= best.score - 5) {
      status = "SUGGESTED";
    } else {
      status = "AUTO_MATCHED";
    }
  } else if (best.score >= THRESHOLDS.SUGGESTED) {
    status = "SUGGESTED";
  } else if (best.score >= THRESHOLDS.REVIEW) {
    status = "REVIEW";
  } else {
    status = "NO_MATCH";
  }

  return {
    status,
    matchType: status === "NO_MATCH" ? null : matchType,
    score: best.score,
    resolvedAccountId: best.bankMovement.accountId,
    bestCandidateId: status === "NO_MATCH" ? null : best.bankMovement.id,
    alternatives: scored.slice(1, 6).map((s) => s.bankMovement.id),
    outOfScopeReason: null,
  };
}

function inferMatchType(
  t: TesoreriaMovement,
  b: BankMovement
): MatchDecision["matchType"] {
  const dayMs = 24 * 60 * 60 * 1000;
  const abs = Math.abs(
    Math.round((b.postDate.getTime() - t.fecha.getTime()) / dayMs)
  );
  if (abs === 0) return "EXACT_SAME_DAY";
  if (abs <= 3) return "EXACT_PM3";
  return "EXACT_PM7";
}

/* =============================== Orchestrator =============================== */

interface RunOptions {
  /** Re-evaluar Consolidados en estados abiertos (NO_MATCH, SUGGESTED, REVIEW). */
  reEvaluateOpen?: boolean;
  /** Solo procesar un subconjunto por ID Tesoreria (útil para tests). */
  tesoreriaIds?: string[];
}

/**
 * Corre el matching sobre TesoreriaMovements sin Consolidado, opcionalmente
 * también sobre los que están en estado abierto (re-evaluación al subir
 * cartolas nuevas).
 */
export async function runConsolidados(opts: RunOptions = {}): Promise<RunSummary> {
  const t0 = Date.now();
  const summary: RunSummary = {
    ok: true,
    processed: 0,
    autoMatched: 0,
    suggested: 0,
    review: 0,
    noMatch: 0,
    outOfScope: 0,
    errors: 0,
    ms: 0,
  };

  // 1. Determinar qué TesoreriaMovements procesar
  const openStatuses = ["NO_MATCH", "SUGGESTED", "REVIEW"];
  const tesorerias = await prisma.tesoreriaMovement.findMany({
    where: {
      ...(opts.tesoreriaIds ? { id: { in: opts.tesoreriaIds } } : {}),
      OR: [
        { consolidado: null },
        ...(opts.reEvaluateOpen
          ? [{ consolidado: { status: { in: openStatuses } } }]
          : []),
      ],
    },
    include: { consolidado: true },
    orderBy: { fecha: "asc" },
  });

  if (tesorerias.length === 0) {
    summary.ms = Date.now() - t0;
    return summary;
  }

  // 2. Pre-cargar todos los BankMovements de tipo IN dentro del rango total
  const minFecha = tesorerias.reduce(
    (m, t) => (t.fecha < m ? t.fecha : m),
    tesorerias[0].fecha
  );
  const maxFecha = tesorerias.reduce(
    (m, t) => (t.fecha > m ? t.fecha : m),
    tesorerias[0].fecha
  );
  const dayMs = 24 * 60 * 60 * 1000;
  const lowerBound = new Date(minFecha.getTime() - DATE_WINDOW_DAYS * dayMs);
  const upperBound = new Date(maxFecha.getTime() + DATE_WINDOW_DAYS * dayMs);

  const bankMovementsInRange = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      postDate: { gte: lowerBound, lte: upperBound },
      // No incluidos en otro Consolidado (un BM solo puede estar en uno)
      consolidadoLinks: { none: {} },
    },
    include: { account: true },
    orderBy: { postDate: "asc" },
  });

  // Index para búsqueda rápida: amount → BM[]
  const byAmount = new Map<string, Array<typeof bankMovementsInRange[number]>>();
  for (const bm of bankMovementsInRange) {
    const key = bm.amount.toString();
    const arr = byAmount.get(key) ?? [];
    arr.push(bm);
    byAmount.set(key, arr);
  }

  // 3. Procesar uno a uno
  for (const t of tesorerias) {
    summary.processed++;
    try {
      const accounts = await resolveCandidateAccounts(t.banco);
      const accountIds = new Set(accounts.map((a) => a.id));

      // Candidatos: mismo monto, dentro de la cuenta resuelta, en ventana
      const lowerT = new Date(t.fecha.getTime() - DATE_WINDOW_DAYS * dayMs);
      const upperT = new Date(t.fecha.getTime() + DATE_WINDOW_DAYS * dayMs);
      const sameAmount = byAmount.get(t.monto.toString()) ?? [];
      const candidates = sameAmount.filter(
        (bm) =>
          accountIds.has(bm.accountId) &&
          bm.postDate >= lowerT &&
          bm.postDate <= upperT
      );

      const decision = decideMatch(t, accounts, candidates);

      // Persistir
      await applyDecision(t.id, decision);

      // Contadores
      switch (decision.status) {
        case "AUTO_MATCHED":
          summary.autoMatched++;
          break;
        case "SUGGESTED":
          summary.suggested++;
          break;
        case "REVIEW":
          summary.review++;
          break;
        case "NO_MATCH":
          summary.noMatch++;
          break;
        case "OUT_OF_SCOPE":
          summary.outOfScope++;
          break;
      }
    } catch (e) {
      summary.errors++;
      console.error(
        `[consolidados] error procesando tesoreria id=${t.id}`,
        e instanceof Error ? e.message : e
      );
    }
  }

  summary.ms = Date.now() - t0;
  return summary;
}

/**
 * Persiste la decisión en BD: upsert del Consolidado + sus links.
 */
async function applyDecision(
  tesoreriaId: string,
  d: MatchDecision
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.consolidado.findUnique({
      where: { tesoreriaMovementId: tesoreriaId },
    });

    // Reset links previos (re-evaluación puede cambiar la elección)
    if (existing) {
      await tx.consolidadoLink.deleteMany({
        where: { consolidadoId: existing.id },
      });
    }

    const data = {
      status: d.status,
      matchType: d.matchType,
      score: d.score,
      resolvedAccountId: d.resolvedAccountId,
      outOfScopeReason: d.outOfScopeReason,
    };

    const consolidado = existing
      ? await tx.consolidado.update({
          where: { id: existing.id },
          data: { ...data, matchedAt: new Date() },
        })
      : await tx.consolidado.create({
          data: {
            tesoreriaMovementId: tesoreriaId,
            ...data,
          },
        });

    // Crear links: solo si AUTO_MATCHED o SUGGESTED (con bestCandidateId)
    // En REVIEW dejamos al usuario elegir; en NO_MATCH/OUT_OF_SCOPE no hay links.
    if (
      (d.status === "AUTO_MATCHED" || d.status === "SUGGESTED") &&
      d.bestCandidateId
    ) {
      await tx.consolidadoLink.create({
        data: {
          consolidadoId: consolidado.id,
          bankMovementId: d.bestCandidateId,
        },
      });
    }
  });
}
