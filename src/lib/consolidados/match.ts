/**
 * Motor de matching V2 para Consolidados (Tesoreria <-> BankMovement).
 *
 * Cambios clave vs V1 (basados en analisis sobre datos reales):
 *  1. Resolucion de cuenta ESTRICTA via BankAccountAlias. Sin alias para el
 *     string `banco` de Tesoreria => OUT_OF_SCOPE (con razon explicita).
 *     El fuzzy matching por bankCode (V1) confundia las multiples cuentas
 *     Santander entre si y por eso AUTO_MATCHED quedaba en 0.
 *  2. Distancia de fechas por fecha CALENDARIO (no datetime). El delta antes
 *     se calculaba en horas y daba "abono anterior a venta" (-15) para casos
 *     same-day que solo diferian en horas.
 *  3. RUT del cliente con peso bajo (+10) y sin penalizacion por contradiccion:
 *     el banco suele registrar el RUT de la empresa procesadora, no del
 *     cliente final, asi que el contraste no es señal confiable.
 *  4. Match por NOMBRE en multiples direcciones:
 *     - apellido de t.clienteName aparece en bm.counterpartyName (+25)
 *     - tokens significativos de t.glosa aparecen en bm.counterpartyName (+15)
 *  5. Threshold de AUTO_MATCHED baja a 50 (de 80) cuando la cuenta esta firme
 *     por alias y el candidato es UNICO en la ventana.
 *  6. Splits 1:N (2-3 partes) para casos donde un movimiento de Tesoreria se
 *     concilia con multiples abonos del mismo dia.
 */
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";
import type {
  BankAccount,
  BankMovement,
  TesoreriaMovement,
} from "@prisma/client";

/* ============================== Constantes ============================== */

const DATE_WINDOW_DAYS = 7;

const THRESHOLDS = {
  // Con cuenta firme por alias y candidato unico, basta score >= 50.
  AUTO_MATCHED: 50,
  SUGGESTED: 35,
  REVIEW: 20,
} as const;

const WEIGHTS = {
  // Monto exacto (precondicion, siempre presente)
  amount_exact: 30,

  // Fecha (calendario)
  same_day: 25,
  diff_1d: 18,
  diff_2d: 12,
  diff_3d: 6,
  diff_4_7d: 3,

  // RUT (peso bajo, ver doc del archivo)
  rut_match: 10,

  // Nombre del cliente Tesoreria vs counterparty del banco
  name_apellido_match: 25, // apellido (primer token de clienteName) aparece en counterpartyName
  name_token_match: 12, // cualquier otro token significativo coincide

  // Tokens de la glosa de Tesoreria coincidiendo con counterparty
  glosa_token_match: 15,

  // Coherencia temporal
  temporal_after: 3, // abono posterior o igual a venta (lógico)
  temporal_far_after: -5, // abono > 7d despues (cartola retrasada o caso raro)
} as const;

/* ================================ Tipos ================================ */

export interface ScoreFactor {
  key: keyof typeof WEIGHTS;
  label: string;
  weight: number;
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
    | "SPLIT_SAME_DAY"
    | "SPLIT_PM3"
    | "MANUAL"
    | null;
  score: number | null;
  resolvedAccountId: string | null;
  bestCandidateIds: string[]; // 1 para 1:1, N para splits
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
  splits: number; // cuantos resolvieron como split 1:N
  errors: number;
  ms: number;
}

/* ============================ Bank resolution ============================ */

/**
 * Resuelve la cuenta bancaria para un string `banco` de Tesoreria, usando
 * el catalogo BankAccountAlias. Sin alias => null (caera en OUT_OF_SCOPE).
 *
 * Implementacion: cache en memoria por llamada de runConsolidados.
 */
async function loadAliasMap(): Promise<Map<string, BankAccount>> {
  const aliases = await prisma.bankAccountAlias.findMany({
    include: { account: true },
  });
  const m = new Map<string, BankAccount>();
  for (const a of aliases) m.set(a.bancoString, a.account);
  return m;
}

/* ============================ Glosa / Nombres ============================ */

// Stopwords del dominio: no aportan a la identificacion del cliente
const GLOSA_STOPWORDS = new Set([
  "DEP", "DEPOSITO", "DEPOSITOS",
  "BCI", "ME", "BAGO", "MG",
  "SANTANDER", "CHILE", "INTERNACIONAL",
  "BOL", "BOLETA", "BOLETAS",
  "FACT", "FACTURA",
  "TICKET", "TKT", "TCKT", "TKTS",
  "REF", "AUT", "OP", "ENVIO", "APP",
  "TRF", "TRANSF", "TRANSFERENCIA", "TRANSFIERE",
  "GIRO", "GIROS",
  "DE", "DEL", "LA", "EL", "Y", "EN", "POR",
  "SPA", "LTDA", "LIMITADA", "S A", "SA",
  "REG", "MOV",
  "MAS", "X",
]);

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

function tokenize(s: string | null | undefined, minLen = 3): string[] {
  if (!s) return [];
  return stripDiacritics(s)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= minLen && !/^[0-9]+$/.test(t) && !GLOSA_STOPWORDS.has(t));
}

/**
 * Calcula factores de scoring relacionados a nombres y glosa.
 */
function scoreNameAndGlosa(
  t: TesoreriaMovement,
  bm: BankMovement
): ScoreFactor[] {
  const factors: ScoreFactor[] = [];

  const cpName = stripDiacritics(bm.counterpartyName ?? "");
  if (!cpName) return factors;

  // 1. Apellido del clienteName (primer token antes de la coma) en counterparty
  if (t.clienteName) {
    const apellido = stripDiacritics(t.clienteName.split(",")[0] ?? "").trim();
    if (apellido.length >= 3 && cpName.includes(apellido)) {
      factors.push({
        key: "name_apellido_match",
        label: `Apellido "${apellido}" en banco`,
        weight: WEIGHTS.name_apellido_match,
      });
      return factors; // No doble contar con token_match
    }

    // 2. Tokens del clienteName en counterparty (caso "BANMEDICA S A" vs "BANMEDICA")
    const tokensCliente = tokenize(t.clienteName);
    const matched = tokensCliente.filter((tok) => cpName.includes(tok));
    if (matched.length > 0) {
      factors.push({
        key: "name_token_match",
        label: `Token cliente "${matched[0]}" en banco`,
        weight: WEIGHTS.name_token_match,
      });
      return factors;
    }
  }

  // 3. Tokens de la GLOSA en counterparty (cuando clienteName=null pero
  //    la glosa menciona al cliente, ej. "DEP. BCI ME SUSANA VENEGAS BOL...")
  const tokensGlosa = tokenize(t.glosa);
  for (const tok of tokensGlosa) {
    if (cpName.includes(tok)) {
      factors.push({
        key: "glosa_token_match",
        label: `Token glosa "${tok}" en banco`,
        weight: WEIGHTS.glosa_token_match,
      });
      break;
    }
  }

  return factors;
}

/* =============================== Scoring =============================== */

/** Diferencia en dias CALENDARIO (no datetime). Positivo = bm despues de t. */
function calendarDaysDelta(t: TesoreriaMovement, bm: BankMovement): number {
  const tDay = new Date(t.fecha.getFullYear(), t.fecha.getMonth(), t.fecha.getDate());
  const bDay = new Date(
    bm.postDate.getFullYear(),
    bm.postDate.getMonth(),
    bm.postDate.getDate()
  );
  return Math.round((bDay.getTime() - tDay.getTime()) / (24 * 60 * 60 * 1000));
}

export function scoreCandidate(
  t: TesoreriaMovement,
  bm: BankMovement
): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [];

  // 1. Monto exacto
  factors.push({
    key: "amount_exact",
    label: "Monto exacto",
    weight: WEIGHTS.amount_exact,
  });

  // 2. Distancia de fechas (calendario)
  const delta = calendarDaysDelta(t, bm);
  const abs = Math.abs(delta);
  if (abs === 0) {
    factors.push({ key: "same_day", label: "Mismo día", weight: WEIGHTS.same_day });
  } else if (abs === 1) {
    factors.push({ key: "diff_1d", label: "±1 día", weight: WEIGHTS.diff_1d });
  } else if (abs === 2) {
    factors.push({ key: "diff_2d", label: "±2 días", weight: WEIGHTS.diff_2d });
  } else if (abs === 3) {
    factors.push({ key: "diff_3d", label: "±3 días", weight: WEIGHTS.diff_3d });
  } else if (abs <= 7) {
    factors.push({
      key: "diff_4_7d",
      label: `±${abs} días`,
      weight: WEIGHTS.diff_4_7d,
    });
  }

  // 3. Coherencia temporal (suave)
  if (delta >= 0 && abs > 0 && abs <= 7) {
    factors.push({
      key: "temporal_after",
      label: "Abono posterior a venta",
      weight: WEIGHTS.temporal_after,
    });
  } else if (delta > 7) {
    factors.push({
      key: "temporal_far_after",
      label: "Abono > 7d después (sospechoso)",
      weight: WEIGHTS.temporal_far_after,
    });
  }

  // 4. RUT (peso bajo)
  const tRut = normalizeRut(t.clienteRut);
  const bRut = normalizeRut(bm.counterpartyRut);
  if (tRut && bRut && tRut === bRut) {
    factors.push({ key: "rut_match", label: "RUT coincide", weight: WEIGHTS.rut_match });
  }

  // 5. Nombre / glosa
  factors.push(...scoreNameAndGlosa(t, bm));

  const total = factors.reduce((sum, f) => sum + f.weight, 0);
  return { score: total, factors };
}

/* ============================== Match logic ============================== */

function inferMatchType(delta: number, isSplit: boolean): MatchDecision["matchType"] {
  const abs = Math.abs(delta);
  if (isSplit) {
    return abs === 0 ? "SPLIT_SAME_DAY" : "SPLIT_PM3";
  }
  if (abs === 0) return "EXACT_SAME_DAY";
  if (abs <= 3) return "EXACT_PM3";
  return "EXACT_PM7";
}

/**
 * Detecta un split: combinacion de 2 o 3 BankMovements en la cuenta correcta,
 * dentro de ±3 dias, que sumen exacto al monto de Tesoreria.
 *
 * Devuelve el mejor grupo (preferentemente del mismo dia) o null.
 */
function detectSplit(
  t: TesoreriaMovement,
  candidatesAnyAmount: Array<BankMovement & { account: BankAccount }>
): Array<BankMovement & { account: BankAccount }> | null {
  // Solo considerar BMs cuyo monto < total de Tesoreria
  const pool = candidatesAnyAmount.filter((bm) => bm.amount < t.monto);
  if (pool.length < 2) return null;

  const targetAmount = t.monto;

  // Probar pares
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pool[i].amount + pool[j].amount === targetAmount) {
        return [pool[i], pool[j]];
      }
    }
  }

  // Probar tripletas (limite de busqueda para no explotar)
  if (pool.length <= 20) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const remaining = targetAmount - pool[i].amount - pool[j].amount;
        if (remaining <= 0n) continue;
        for (let k = j + 1; k < pool.length; k++) {
          if (pool[k].amount === remaining) {
            return [pool[i], pool[j], pool[k]];
          }
        }
      }
    }
  }

  return null;
}

/**
 * Toma la decision de match para un movimiento Tesoreria.
 */
export function decideMatch(
  t: TesoreriaMovement,
  resolvedAccount: BankAccount | null,
  candidates: Array<BankMovement & { account: BankAccount }>,
  splitPool: Array<BankMovement & { account: BankAccount }>
): MatchDecision {
  // 1. Sin cuenta resuelta por alias => OUT_OF_SCOPE
  if (!resolvedAccount) {
    return {
      status: "OUT_OF_SCOPE",
      matchType: null,
      score: null,
      resolvedAccountId: null,
      bestCandidateIds: [],
      alternatives: [],
      outOfScopeReason: t.banco
        ? `Sin alias configurado para "${t.banco}". Crear en Configuracion -> Mapeo de cuentas.`
        : "Tesoreria sin banco asignado",
    };
  }

  // 2. Excepcion API => REVIEW directo (la API marca el movimiento como sospechoso)
  if (t.esExcepcion) {
    const best = candidates[0];
    return {
      status: "REVIEW",
      matchType: null,
      score: null,
      resolvedAccountId: resolvedAccount.id,
      bestCandidateIds: best ? [best.id] : [],
      alternatives: candidates.slice(1, 6).map((c) => c.id),
      outOfScopeReason: null,
    };
  }

  // 3. Sin candidatos por monto exacto => intentar split
  if (candidates.length === 0) {
    const splitGroup = detectSplit(t, splitPool);
    if (splitGroup) {
      const minDelta = Math.min(...splitGroup.map((bm) => Math.abs(calendarDaysDelta(t, bm))));
      return {
        status: "SUGGESTED", // Splits siempre revisados, no AUTO
        matchType: inferMatchType(minDelta, true),
        score: 50,
        resolvedAccountId: resolvedAccount.id,
        bestCandidateIds: splitGroup.map((bm) => bm.id),
        alternatives: [],
        outOfScopeReason: null,
      };
    }
    return {
      status: "NO_MATCH",
      matchType: null,
      score: null,
      resolvedAccountId: resolvedAccount.id,
      bestCandidateIds: [],
      alternatives: [],
      outOfScopeReason: null,
    };
  }

  // 4. Scorear todos los candidatos y ordenar
  const scored: ScoredCandidate[] = candidates
    .map((c) => {
      const { score, factors } = scoreCandidate(t, c);
      return { bankMovement: c, score, factors };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const delta = calendarDaysDelta(t, best.bankMovement);
  const matchType = inferMatchType(delta, false);

  // 5. Decision por score + unicidad
  let status: MatchDecision["status"];
  if (scored.length === 1) {
    // Unico candidato en cuenta correcta + monto exacto = altísima confianza
    if (best.score >= THRESHOLDS.AUTO_MATCHED) status = "AUTO_MATCHED";
    else if (best.score >= THRESHOLDS.SUGGESTED) status = "SUGGESTED";
    else status = "REVIEW";
  } else {
    // Multiples candidatos: requiere margen claro para AUTO
    const margin = best.score - scored[1].score;
    if (best.score >= THRESHOLDS.AUTO_MATCHED && margin >= 12) {
      status = "AUTO_MATCHED";
    } else if (best.score >= THRESHOLDS.SUGGESTED) {
      status = "SUGGESTED";
    } else if (best.score >= THRESHOLDS.REVIEW) {
      status = "REVIEW";
    } else {
      status = "NO_MATCH";
    }
  }

  return {
    status,
    matchType: status === "NO_MATCH" ? null : matchType,
    score: best.score,
    resolvedAccountId: resolvedAccount.id,
    bestCandidateIds: status === "NO_MATCH" ? [] : [best.bankMovement.id],
    alternatives: scored.slice(1, 6).map((s) => s.bankMovement.id),
    outOfScopeReason: null,
  };
}

/* =============================== Orchestrator =============================== */

interface RunOptions {
  reEvaluateOpen?: boolean;
  tesoreriaIds?: string[];
}

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
    splits: 0,
    errors: 0,
    ms: 0,
  };

  const aliasMap = await loadAliasMap();

  const openStatuses = ["NO_MATCH", "SUGGESTED", "REVIEW", "OUT_OF_SCOPE"];
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

  // Pre-cargar BankMovements en el rango total
  const minFecha = tesorerias.reduce(
    (m, t) => (t.fecha < m ? t.fecha : m),
    tesorerias[0].fecha
  );
  const maxFecha = tesorerias.reduce(
    (m, t) => (t.fecha > m ? t.fecha : m),
    tesorerias[0].fecha
  );
  const dayMs = 24 * 60 * 60 * 1000;
  const lower = new Date(minFecha.getTime() - DATE_WINDOW_DAYS * dayMs);
  const upper = new Date(maxFecha.getTime() + DATE_WINDOW_DAYS * dayMs);

  // Set de bm IDs ya ligados (no se reusan en este run)
  const linkedRows = await prisma.consolidadoLink.findMany({
    select: { bankMovementId: true },
  });
  const alreadyLinked = new Set(linkedRows.map((l) => l.bankMovementId));

  const allBms = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      postDate: { gte: lower, lte: upper },
      id: { notIn: Array.from(alreadyLinked).length > 0 ? Array.from(alreadyLinked) : [""] },
    },
    include: { account: true },
    orderBy: { postDate: "asc" },
  });

  // Indices
  const bmsByAccount = new Map<string, typeof allBms>();
  for (const bm of allBms) {
    const arr = bmsByAccount.get(bm.accountId) ?? [];
    arr.push(bm);
    bmsByAccount.set(bm.accountId, arr);
  }

  // Procesar uno a uno
  for (const t of tesorerias) {
    summary.processed++;
    try {
      const resolvedAccount = t.banco ? aliasMap.get(t.banco) ?? null : null;

      let candidates: typeof allBms = [];
      let splitPool: typeof allBms = [];

      if (resolvedAccount) {
        const lowerT = new Date(t.fecha.getTime() - DATE_WINDOW_DAYS * dayMs);
        const upperT = new Date(t.fecha.getTime() + DATE_WINDOW_DAYS * dayMs);
        const inAccount = bmsByAccount.get(resolvedAccount.id) ?? [];
        candidates = inAccount.filter(
          (bm) =>
            bm.amount === t.monto &&
            bm.postDate >= lowerT &&
            bm.postDate <= upperT
        );

        // Para splits, usamos ventana mas estrecha (±3d) y monto != exacto
        const splitLower = new Date(t.fecha.getTime() - 3 * dayMs);
        const splitUpper = new Date(t.fecha.getTime() + 3 * dayMs);
        splitPool = inAccount.filter(
          (bm) =>
            bm.amount !== t.monto &&
            bm.postDate >= splitLower &&
            bm.postDate <= splitUpper
        );
      }

      const decision = decideMatch(t, resolvedAccount, candidates, splitPool);
      await applyDecision(t.id, decision);

      switch (decision.status) {
        case "AUTO_MATCHED":
          summary.autoMatched++;
          break;
        case "SUGGESTED":
          summary.suggested++;
          if (decision.bestCandidateIds.length > 1) summary.splits++;
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

async function applyDecision(
  tesoreriaId: string,
  d: MatchDecision
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.consolidado.findUnique({
      where: { tesoreriaMovementId: tesoreriaId },
    });

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
          data: { tesoreriaMovementId: tesoreriaId, ...data },
        });

    // Crear links cuando hay candidatos (AUTO_MATCHED / SUGGESTED)
    if (
      (d.status === "AUTO_MATCHED" || d.status === "SUGGESTED") &&
      d.bestCandidateIds.length > 0
    ) {
      await tx.consolidadoLink.createMany({
        data: d.bestCandidateIds.map((bmId) => ({
          consolidadoId: consolidado.id,
          bankMovementId: bmId,
        })),
        skipDuplicates: true,
      });
    }
  });
}

/* ============== Compat: resolveCandidateAccounts (legacy API route) ============== */
/**
 * Mantenida por compatibilidad con /api/consolidados/[id]/route.ts que la
 * importaba. Ahora devuelve la cuenta resuelta por alias (o vacio).
 */
export async function resolveCandidateAccounts(
  banco: string | null | undefined
): Promise<BankAccount[]> {
  if (!banco) return [];
  const alias = await prisma.bankAccountAlias.findUnique({
    where: { bancoString: banco },
    include: { account: true },
  });
  return alias ? [alias.account] : [];
}
