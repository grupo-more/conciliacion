/**
 * Motor de matching V3 para Consolidados (Tesoreria <-> BankMovement).
 *
 * Filosofia: una pasada que wipea y reconstruye TODO usando asignacion
 * bipartita greedy ordenada por score. Un BM nunca va a dos Consolidados.
 * Cada Tesoreria se asocia con SU mejor opcion disponible globalmente.
 *
 * Direccion: cada Tesoreria se concilia contra el lado correcto de la cartola
 * segun tipoOperacion: INGRESO -> BankMovement IN, EGRESO -> BankMovement OUT.
 * Los montos de egreso vienen negativos (igual que los OUT de cartola), asi
 * que el match exacto por monto funciona en ambos signos; las comparaciones
 * de orden (splits) se hacen en magnitud.
 *
 * Tipos de candidato (todos compiten en el mismo ranking):
 *   1. 1:1 exacto en cuenta del alias
 *   2. Split 2 o 3 partes en cuenta del alias
 *   3. 1:1 en OTRA cuenta del MISMO banco — solo si hay match firme de
 *      nombre/RUT (excepcion: la API etiqueto mal el banco)
 *
 * Algoritmo:
 *   FASE 1: para cada Tesoreria, computar todos sus candidatos posibles con
 *           score. Filtrar por esExcepcion y existencia de alias.
 *   FASE 2: aplanar todos los pares (Tesoreria, candidato) y ordenar por
 *           score desc, con tiebreakers estables.
 *   FASE 3: greedy: tomar el par de mayor score. Marcar Tesoreria y sus BMs
 *           como asignados. Repetir hasta agotar.
 *   FASE 4: persistir en una sola transaccion (wipe + insert).
 *
 * Garantias:
 *   - Determinismo: mismo input + mismo dia => mismo resultado.
 *   - Atomicidad: o se aplica todo o nada (transaccion).
 *   - Sin races: serial dentro del run.
 */
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";
import { parseGlosa } from "@/lib/consolidados/glosa";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";
import type {
  BankAccount,
  BankAccountAlias,
  BankMovement,
  TesoreriaMovement,
} from "@prisma/client";

/* ============================== Constantes ============================== */

const DATE_WINDOW_DAYS = 7;
const SPLIT_WINDOW_DAYS = 3;
const SPLIT_MAX_PARTS = 3;

const THRESHOLDS = {
  AUTO_MATCHED: 50,
  SUGGESTED: 35,
  REVIEW: 20,
} as const;

const WEIGHTS = {
  // Precondicion (siempre presente cuando hay candidato)
  amount_exact: 30,

  // Fecha calendario
  same_day: 25,
  diff_1d: 18,
  diff_2d: 12,
  diff_3d: 6,
  diff_4_7d: 3,

  // RUT cliente (peso bajo: banco a veces trae RUT empresa)
  rut_match: 10,

  // Nombre cliente vs counterparty
  name_apellido_match: 25,
  name_token_match: 12,
  glosa_token_match: 15,

  // Coherencia temporal
  temporal_after: 3,
  temporal_far_after: -5,

  // Penalizaciones
  split_penalty: -5,
  wrong_account_penalty: -15,
} as const;

/* ================================ Tipos ================================ */

type BMWithAccount = BankMovement & { account: BankAccount };

export interface ScoreFactor {
  key: keyof typeof WEIGHTS;
  label: string;
  weight: number;
}

interface CandidateBase {
  tesoreriaId: string;
  bms: BMWithAccount[];
  score: number;
  factors: ScoreFactor[];
  matchType: NonNullable<Consolidado["matchType"]>;
  status: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW";
  isException: boolean;
  primaryDeltaDays: number; // para tiebreakers
}

interface Consolidado {
  status: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" | "NO_MATCH" | "OUT_OF_SCOPE";
  matchType:
    | "EXACT_SAME_DAY"
    | "EXACT_PM3"
    | "EXACT_PM7"
    | "SPLIT_SAME_DAY"
    | "SPLIT_PM3"
    | "ACCOUNT_MISMATCH"
    | "MANUAL"
    | null;
}

export interface RunSummary {
  ok: boolean;
  processed: number;
  autoMatched: number;
  suggested: number;
  review: number;
  noMatch: number;
  outOfScope: number;
  anulados: number; // movimientos anulados en origen (estadoActual=ANU)
  splits: number;
  exceptions: number; // matches con account mismatch
  errors: number;
  ms: number;
}

/* ============================ Helpers ============================ */

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

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
  "DE", "DEL", "LA", "EL", "Y", "EN", "POR", "CON",
  "SPA", "LTDA", "LIMITADA", "S A", "SA",
  "REG", "MOV",
  "MAS", "X",
]);

function tokenize(s: string | null | undefined, minLen = 3): string[] {
  if (!s) return [];
  return stripDiacritics(s)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= minLen && !/^[0-9]+$/.test(t) && !GLOSA_STOPWORDS.has(t));
}

/** Diferencia en dias calendario, signado (positivo = bm posterior a t). */
function calendarDaysDelta(t: TesoreriaMovement, bm: BankMovement): number {
  const tDay = new Date(t.fecha.getFullYear(), t.fecha.getMonth(), t.fecha.getDate());
  const bDay = new Date(
    bm.postDate.getFullYear(),
    bm.postDate.getMonth(),
    bm.postDate.getDate()
  );
  return Math.round((bDay.getTime() - tDay.getTime()) / (24 * 60 * 60 * 1000));
}

/** Si hay match de nombre o RUT firme entre Tesoreria y BankMovement.
 *
 *  Estrategia tolerante a los formatos de nombre del banco:
 *  - "HOYOS MESA, JORGE ALVEIRO" puede llegar al banco como "JORGE ALVEIRO H"
 *    o como "HOYOS, JORGE", o como solo "JORGE ALVEIRO". Cualquiera vale si
 *    coincide al menos un token significativo (>=4 chars, no stopword).
 */
function hasStrongNameOrRutMatch(
  t: TesoreriaMovement,
  bm: BankMovement
): boolean {
  // 1) RUT match firme
  const tRut = normalizeRut(t.clienteRut);
  const bRut = normalizeRut(bm.counterpartyRut);
  if (tRut && bRut && tRut === bRut && tRut !== "55555555-5") return true;

  // 2) Nombre: al menos un token >=4 chars del clienteName aparece en counterparty
  const cpName = stripDiacritics(bm.counterpartyName ?? "");
  if (!cpName) return false;
  if (!t.clienteName || t.clienteName.toUpperCase().includes("GENERICO")) return false;

  // Tokens largos (>=4) para reducir falsos positivos
  const tokens = tokenize(t.clienteName, 4);
  for (const tok of tokens) {
    if (cpName.includes(tok)) return true;
  }
  return false;
}

/** RUT embebido en la glosa de Tesoreria (ej. "DEP 76.810.587-1 ..."). */
function rutFromGlosa(glosa: string | null | undefined): string | null {
  if (!glosa) return null;
  const m = glosa.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dKk]|\d{7,9}-?[\dKk])/);
  return m ? normalizeRut(m[1]) : null;
}

/**
 * Identidad por GLOSA (para clientes GENERICO sin clienteName/RUT propio):
 * RUT en la glosa que coincide con el counterparty del banco, o un token de
 * nombre de la glosa presente en el counterparty. Se usa SOLO para habilitar
 * el match cross-cuenta (banco mal asignado), nunca para el match directo.
 */
function glosaIdentityMatch(t: TesoreriaMovement, bm: BankMovement): boolean {
  const gRut = rutFromGlosa(t.glosa);
  const bRut = normalizeRut(bm.counterpartyRut);
  if (gRut && bRut && gRut === bRut && gRut !== "55555555-5") return true;
  // RUT de glosa tambien puede venir en la descripcion del banco
  if (gRut && gRut !== "55555555-5") {
    const desc = stripDiacritics(bm.description ?? "");
    const gNum = gRut.replace(/[.\-]/g, "");
    if (gNum.length >= 7 && desc.replace(/[.\-]/g, "").includes(gNum)) return true;
  }
  const cpName = stripDiacritics(bm.counterpartyName ?? "");
  if (!cpName) return false;
  return tokenize(t.glosa, 4).some((tok) => cpName.includes(tok));
}

/* =============================== Scoring =============================== */

function scoreOnePair(
  t: TesoreriaMovement,
  bm: BankMovement,
  options: { wrongAccount?: boolean } = {}
): { score: number; factors: ScoreFactor[]; deltaDays: number } {
  const factors: ScoreFactor[] = [];

  // 1. Monto exacto (siempre)
  factors.push({
    key: "amount_exact",
    label: "Monto exacto",
    weight: WEIGHTS.amount_exact,
  });

  // 2. Fecha
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

  // 3. Coherencia temporal
  if (delta >= 0 && abs > 0 && abs <= 7) {
    factors.push({
      key: "temporal_after",
      label: "Abono posterior a venta",
      weight: WEIGHTS.temporal_after,
    });
  } else if (delta > 7) {
    factors.push({
      key: "temporal_far_after",
      label: "Abono > 7d después",
      weight: WEIGHTS.temporal_far_after,
    });
  }

  // 4. RUT
  const tRut = normalizeRut(t.clienteRut);
  const bRut = normalizeRut(bm.counterpartyRut);
  if (tRut && bRut && tRut === bRut && tRut !== "55555555-5") {
    factors.push({ key: "rut_match", label: "RUT coincide", weight: WEIGHTS.rut_match });
  }

  // 5. Nombre / glosa
  const cpName = stripDiacritics(bm.counterpartyName ?? "");
  if (cpName && t.clienteName) {
    const isGeneric = t.clienteName.toUpperCase().includes("GENERICO");

    if (!isGeneric) {
      const apellido = stripDiacritics(t.clienteName.split(",")[0] ?? "").trim();
      if (apellido.length >= 3 && cpName.includes(apellido)) {
        factors.push({
          key: "name_apellido_match",
          label: `Apellido "${apellido}" en banco`,
          weight: WEIGHTS.name_apellido_match,
        });
      } else {
        const tokensCliente = tokenize(t.clienteName);
        const matched = tokensCliente.find((tok) => cpName.includes(tok));
        if (matched) {
          factors.push({
            key: "name_token_match",
            label: `Token cliente "${matched}" en banco`,
            weight: WEIGHTS.name_token_match,
          });
        }
      }
    }

    // Tokens de glosa (util para CLIENTE GENERICO o caso de fallback)
    if (
      !factors.some((f) => f.key === "name_apellido_match" || f.key === "name_token_match")
    ) {
      const tokensGlosa = tokenize(t.glosa);
      const matched = tokensGlosa.find((tok) => cpName.includes(tok));
      if (matched) {
        factors.push({
          key: "glosa_token_match",
          label: `Token glosa "${matched}" en banco`,
          weight: WEIGHTS.glosa_token_match,
        });
      }
    }
  }

  // 6. Penalizaciones
  if (options.wrongAccount) {
    factors.push({
      key: "wrong_account_penalty",
      label: "Banco distinto al asignado",
      weight: WEIGHTS.wrong_account_penalty,
    });
  }

  const total = factors.reduce((sum, f) => sum + f.weight, 0);
  return { score: total, factors, deltaDays: delta };
}

function statusForScore(score: number): "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" {
  if (score >= THRESHOLDS.AUTO_MATCHED) return "AUTO_MATCHED";
  if (score >= THRESHOLDS.SUGGESTED) return "SUGGESTED";
  return "REVIEW";
}

function matchTypeFor11(deltaDays: number): NonNullable<Consolidado["matchType"]> {
  const abs = Math.abs(deltaDays);
  if (abs === 0) return "EXACT_SAME_DAY";
  if (abs <= 3) return "EXACT_PM3";
  return "EXACT_PM7";
}

function matchTypeForSplit(deltaDaysMax: number): NonNullable<Consolidado["matchType"]> {
  return Math.abs(deltaDaysMax) === 0 ? "SPLIT_SAME_DAY" : "SPLIT_PM3";
}

/* ============================ Candidate generation ============================ */

/** Genera todos los candidatos para una Tesoreria. */
function generateCandidates(
  t: TesoreriaMovement,
  aliasAccount: BankAccount,
  otherAccounts: BankAccount[],
  bmsByAccount: Map<string, BMWithAccount[]>
): CandidateBase[] {
  const candidates: CandidateBase[] = [];
  const dayMs = 24 * 60 * 60 * 1000;

  const lowerT = new Date(t.fecha.getTime() - DATE_WINDOW_DAYS * dayMs);
  const upperT = new Date(t.fecha.getTime() + DATE_WINDOW_DAYS * dayMs);

  // === 1) 1:1 en cuenta del alias ===
  const aliasBms = bmsByAccount.get(aliasAccount.id) ?? [];
  for (const bm of aliasBms) {
    if (bm.amount !== t.monto) continue;
    if (bm.postDate < lowerT || bm.postDate > upperT) continue;

    const { score, factors, deltaDays } = scoreOnePair(t, bm);
    candidates.push({
      tesoreriaId: t.id,
      bms: [bm],
      score,
      factors,
      matchType: matchTypeFor11(deltaDays),
      status: statusForScore(score),
      isException: false,
      primaryDeltaDays: Math.abs(deltaDays),
    });
  }

  // === 2) Splits en cuenta del alias (2-3 partes, ventana mas estrecha) ===
  const splitLower = new Date(t.fecha.getTime() - SPLIT_WINDOW_DAYS * dayMs);
  const splitUpper = new Date(t.fecha.getTime() + SPLIT_WINDOW_DAYS * dayMs);
  // Partes mas chicas que el total (en magnitud, para servir tanto ingresos
  // con montos positivos como egresos con montos negativos).
  const splitPool = aliasBms.filter(
    (bm) =>
      absBig(bm.amount) < absBig(t.monto) &&
      bm.postDate >= splitLower &&
      bm.postDate <= splitUpper
  );

  // Pares
  for (let i = 0; i < splitPool.length; i++) {
    for (let j = i + 1; j < splitPool.length; j++) {
      const a = splitPool[i];
      const b = splitPool[j];
      if (a.amount + b.amount !== t.monto) continue;

      const sA = scoreOnePair(t, a);
      const sB = scoreOnePair(t, b);
      const avgScore = (sA.score + sB.score) / 2 + WEIGHTS.split_penalty;
      const maxAbsDelta = Math.max(Math.abs(sA.deltaDays), Math.abs(sB.deltaDays));

      candidates.push({
        tesoreriaId: t.id,
        bms: [a, b],
        score: avgScore,
        factors: [
          ...sA.factors.map((f) => ({ ...f, label: `[BM1] ${f.label}` })),
          {
            key: "split_penalty",
            label: "Penalización por split",
            weight: WEIGHTS.split_penalty,
          },
        ],
        matchType: matchTypeForSplit(maxAbsDelta),
        status: statusForScore(avgScore),
        isException: false,
        primaryDeltaDays: maxAbsDelta,
      });
    }
  }

  // Tripletas (limite por tamaño para no explotar)
  if (splitPool.length <= 20 && SPLIT_MAX_PARTS >= 3) {
    for (let i = 0; i < splitPool.length; i++) {
      for (let j = i + 1; j < splitPool.length; j++) {
        const remaining = t.monto - splitPool[i].amount - splitPool[j].amount;
        // El tercer pedazo debe existir, ser != 0 y del mismo signo que el
        // total. Para ingresos (positivos) esto equivale al viejo
        // `remaining <= 0n`; generalizado para egresos (montos negativos).
        if (remaining === 0n) continue;
        if ((remaining < 0n) !== (t.monto < 0n)) continue;
        for (let k = j + 1; k < splitPool.length; k++) {
          if (splitPool[k].amount !== remaining) continue;
          const triple = [splitPool[i], splitPool[j], splitPool[k]];
          const scores = triple.map((bm) => scoreOnePair(t, bm));
          const avg = scores.reduce((s, x) => s + x.score, 0) / 3 + WEIGHTS.split_penalty * 2;
          const maxAbs = Math.max(...scores.map((s) => Math.abs(s.deltaDays)));

          candidates.push({
            tesoreriaId: t.id,
            bms: triple,
            score: avg,
            factors: [
              {
                key: "split_penalty",
                label: "Penalización por split 3p",
                weight: WEIGHTS.split_penalty * 2,
              },
            ],
            matchType: matchTypeForSplit(maxAbs),
            status: statusForScore(avg),
            isException: false,
            primaryDeltaDays: maxAbs,
          });
        }
      }
    }
  }

  // === 3) 1:1 en OTRA cuenta (banco mal asignado), mismo banco O cruzado ===
  // Solo con identidad firme: nombre/RUT del cliente, o RUT/nombre en la glosa
  // (para CLIENTE GENERICO). Cruzado de banco => nunca AUTO (cap a SUGGESTED),
  // porque el monto solo entre bancos distintos puede ser coincidencia.
  for (const otherAccount of otherAccounts) {
    if (otherAccount.id === aliasAccount.id) continue;
    const otherBms = bmsByAccount.get(otherAccount.id) ?? [];
    for (const bm of otherBms) {
      if (absBig(bm.amount) !== absBig(t.monto)) continue;
      if (bm.postDate < lowerT || bm.postDate > upperT) continue;
      if (!hasStrongNameOrRutMatch(t, bm) && !glosaIdentityMatch(t, bm)) continue;

      const { score, factors, deltaDays } = scoreOnePair(t, bm, { wrongAccount: true });
      const crossBank = otherAccount.bankCode !== aliasAccount.bankCode;
      let status = statusForScore(score);
      if (crossBank && status === "AUTO_MATCHED") status = "SUGGESTED";
      candidates.push({
        tesoreriaId: t.id,
        bms: [bm],
        score,
        factors,
        matchType: "ACCOUNT_MISMATCH",
        status,
        isException: true,
        primaryDeltaDays: Math.abs(deltaDays),
      });
    }
  }

  return candidates;
}

/* ============================ Bipartite assignment ============================ */

/** Resuelve la asignacion global con greedy ordenado por score desc. */
function bipartiteAssign(
  allCandidates: CandidateBase[]
): CandidateBase[] {
  // Sort: score desc, then deltaDays asc, then tesoreriaId asc (estable)
  const sorted = allCandidates.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.primaryDeltaDays !== b.primaryDeltaDays)
      return a.primaryDeltaDays - b.primaryDeltaDays;
    return a.tesoreriaId.localeCompare(b.tesoreriaId);
  });

  const assignedT = new Set<string>();
  const assignedBM = new Set<string>();
  const result: CandidateBase[] = [];

  for (const cand of sorted) {
    if (assignedT.has(cand.tesoreriaId)) continue;
    if (cand.bms.some((bm) => assignedBM.has(bm.id))) continue;

    result.push(cand);
    assignedT.add(cand.tesoreriaId);
    for (const bm of cand.bms) assignedBM.add(bm.id);
  }

  return result;
}

/* ================================ Orchestrator ================================ */

interface RunOptions {
  /** Si false, conserva los MANUAL existentes. Default true. */
  preserveManual?: boolean;
  /** Si true, NO escribe en BD: simula y devuelve el summary. */
  dryRun?: boolean;
}

/**
 * Mutex anti-concurrencia. Si dos requests llegan al mismo tiempo (click
 * rapido, refresh durante un run, etc), las llamadas posteriores reciben
 * el promise de la corrida en vuelo en vez de iniciar otra. Esto previene:
 *   - Wipe doble
 *   - Inserts duplicados
 *   - Race conditions en la transaccion
 * Ambito: por proceso Node (PM2 fork single). Suficiente para nuestro deploy.
 */
let inFlightRun: Promise<RunSummary> | null = null;

export async function runConsolidados(opts: RunOptions = {}): Promise<RunSummary> {
  if (inFlightRun) {
    console.log("[consolidados] run en curso; devolviendo promise existente");
    return inFlightRun;
  }
  inFlightRun = doRunConsolidados(opts);
  try {
    return await inFlightRun;
  } finally {
    inFlightRun = null;
  }
}

async function doRunConsolidados(opts: RunOptions = {}): Promise<RunSummary> {
  const preserveManual = opts.preserveManual ?? true;
  const dryRun = opts.dryRun ?? false;

  const t0 = Date.now();
  const summary: RunSummary = {
    ok: true,
    processed: 0,
    autoMatched: 0,
    suggested: 0,
    review: 0,
    noMatch: 0,
    outOfScope: 0,
    anulados: 0,
    splits: 0,
    exceptions: 0,
    errors: 0,
    ms: 0,
  };

  // 1) Cargar todo lo necesario
  const [
    aliases,
    allAccounts,
    allBms,
    allTesorerias,
    manualConsolidados,
    previouslyLinked,
  ] = await Promise.all([
    prisma.bankAccountAlias.findMany({ include: { account: true } }),
    prisma.bankAccount.findMany({ where: { active: true } }),
    prisma.bankMovement.findMany({
      // IN para conciliar ingresos, OUT para egresos. Se rutea por cuenta +
      // direccion mas abajo segun tipoOperacion de cada Tesoreria.
      where: { direction: { in: ["IN", "OUT"] } },
      include: { account: true },
      orderBy: { postDate: "asc" },
    }),
    prisma.tesoreriaMovement.findMany({ orderBy: { fecha: "asc" } }),
    preserveManual
      ? prisma.consolidado.findMany({
          where: { status: "MANUAL" },
          include: { links: true },
        })
      : Promise.resolve([]),
    // Snapshot pre-wipe: movimientos que YA estaban conciliados con link real
    // (AUTO_MATCHED o MANUAL). Siguen vivos en BD hasta el wipe de esta corrida.
    // Se usa para alertar si un movimiento ahora anulado estaba conciliado.
    prisma.consolidado.findMany({
      where: { status: { in: ["AUTO_MATCHED", "MANUAL"] } },
      select: { tesoreriaMovementId: true },
    }),
  ]);

  const previouslyLinkedTids = new Set(
    previouslyLinked.map((c) => c.tesoreriaMovementId)
  );

  // Indices
  const aliasMap = new Map<string, BankAccount>();
  for (const a of aliases) aliasMap.set(a.bancoString, a.account);

  const accountsByBankCode = new Map<string, BankAccount[]>();
  for (const acc of allAccounts) {
    if (acc.accountNumber.startsWith("_UNASSIGNED_")) continue;
    const arr = accountsByBankCode.get(acc.bankCode) ?? [];
    arr.push(acc);
    accountsByBankCode.set(acc.bankCode, arr);
  }
  // Todas las cuentas reales (cualquier banco) — para el match cross-cuenta.
  const allRealAccounts = [...accountsByBankCode.values()].flat();

  // BMs que NO se pueden usar (ya estan en un MANUAL)
  const manualBmIds = new Set<string>();
  const manualTesoreriaIds = new Set<string>();
  for (const c of manualConsolidados) {
    manualTesoreriaIds.add(c.tesoreriaMovementId);
    for (const l of c.links) manualBmIds.add(l.bankMovementId);
  }

  // Indexar por cuenta Y direccion. Ingresos se concilian contra IN, egresos
  // contra OUT. Mantener mapas separados evita que un ingreso matchee una
  // salida (o viceversa) cuando coinciden monto/fecha por casualidad.
  const bmsByAccountIN = new Map<string, BMWithAccount[]>();
  const bmsByAccountOUT = new Map<string, BMWithAccount[]>();
  for (const bm of allBms) {
    if (manualBmIds.has(bm.id)) continue;
    // Cuentas de uso parcial: fuera del pool de candidatos del motor (solo sus
    // traspasos internos importan, y esos no van por el motor).
    if (isUsoParcialAccount(bm.account)) continue;
    const target = bm.direction === "OUT" ? bmsByAccountOUT : bmsByAccountIN;
    const arr = target.get(bm.accountId) ?? [];
    arr.push(bm);
    target.set(bm.accountId, arr);
  }

  // 2) Clasificar Tesorerias y generar candidatos
  const allCandidates: CandidateBase[] = [];
  const outOfScopeTids = new Set<string>();
  // esExcepcion=true: la API indica que el deposito entro a un banco distinto
  // del asociado a la sucursal. NO se saltea el scoring: se generan candidatos
  // con la busqueda cross-banco activada (ya pasa allRealAccounts) y se capa el
  // status a SUGGESTED (nunca AUTO) para que se confirme manualmente. Si no
  // aparece candidato, cae a REVIEW (sigue marcada para atencion).
  const exceptionTids = new Set<string>();
  // Tesorerias con glosa "DEP (N) ..." → split inverso. NO se auto-scorea
  // contra cartolas porque su monto es solo una porción del depósito real,
  // y un EXACT/SPLIT contra un BM completo sería un falso positivo.
  const multiPartTids = new Set<string>();
  // Movimientos anulados en origen (estadoActual=ANU): fuera del motor. No
  // generan candidatos ni links; se persisten como status ANULADO. Tiene
  // prioridad sobre cualquier otra clasificacion (un anulado no se concilia
  // aunque tuviera alias o fuera multipart/excepcion).
  const anuladoTids = new Set<string>();

  const processable = allTesorerias.filter((t) => !manualTesoreriaIds.has(t.id));
  summary.processed = processable.length;

  for (const t of processable) {
    // Anulado => fuera de conciliacion (antes que nada).
    if (t.estadoActual === "ANU") {
      anuladoTids.add(t.id);
      continue;
    }

    // Sin alias => OUT_OF_SCOPE
    const aliasAccount = t.banco ? aliasMap.get(t.banco) : undefined;
    if (!aliasAccount) {
      outOfScopeTids.add(t.id);
      continue;
    }

    // Glosa multipart "DEP (N) ..." => REVIEW para link manual. Tiene prioridad
    // incluso sobre la excepcion: el monto del TM sigue siendo parcial, asi que
    // no corre scoring.
    if (parseGlosa(t.glosa).isMultiPart) {
      multiPartTids.add(t.id);
      continue;
    }

    const isException = t.esExcepcion;
    if (isException) exceptionTids.add(t.id);

    // Egreso -> conciliar contra salidas (OUT). Ingreso -> entradas (IN).
    // Confiamos en tipoOperacion; el signo del monto es respaldo defensivo.
    const isEgreso = t.tipoOperacion === "EGRESO" || t.monto < 0n;
    const bmsByAccount = isEgreso ? bmsByAccountOUT : bmsByAccountIN;

    // Cross-cuenta: pasamos TODAS las cuentas reales (no solo las del mismo
    // banco) para recuperar depositos que entraron a una cuenta distinta de la
    // asignada. El gating de identidad evita falsos positivos.
    const cands = generateCandidates(t, aliasAccount, allRealAccounts, bmsByAccount);

    // Excepcion API: marcar todos sus candidatos como excepcion y capar a
    // SUGGESTED. Asi el motor propone el abono que entro al otro banco, pero
    // exige confirmacion humana antes de conciliar.
    if (isException) {
      for (const c of cands) {
        c.isException = true;
        if (c.status === "AUTO_MATCHED") c.status = "SUGGESTED";
      }
    }

    allCandidates.push(...cands);
  }

  // 3) Asignacion bipartita global
  const assigned = bipartiteAssign(allCandidates);
  const assignedByTid = new Map<string, CandidateBase>();
  for (const a of assigned) assignedByTid.set(a.tesoreriaId, a);

  // 4) Persistir (transaccional, atomico)
  if (!dryRun) {
    try {
      await prisma.$transaction(
        async (tx) => {
          // Wipe: eliminar todos los Consolidados que NO son MANUAL
          await tx.consolidadoLink.deleteMany({
            where: {
              consolidado: preserveManual ? { status: { not: "MANUAL" } } : {},
            },
          });
          await tx.consolidado.deleteMany({
            where: preserveManual ? { status: { not: "MANUAL" } } : {},
          });

          // Crear Consolidados nuevos
          for (const t of processable) {
            // Caso 0: ANULADO. El movimiento esta anulado en origen. Se excluye
            // de conciliacion; se alerta si se anulo DESPUES de existir como
            // valido (anulado=true) y especialmente si ya estaba conciliado.
            if (anuladoTids.has(t.id)) {
              const notes =
                t.anulado && previouslyLinkedTids.has(t.id)
                  ? "⚠ ANULADO tras conciliar: el movimiento se anuló (CAJ→ANU) pero ya estaba conciliado. Revisar el abono bancario asociado."
                  : t.anulado
                  ? "Movimiento anulado (CAJ→ANU). Excluido de conciliación."
                  : "Documento anulado en origen. Fuera de conciliación.";
              await tx.consolidado.create({
                data: {
                  tesoreriaMovementId: t.id,
                  status: "ANULADO",
                  matchType: null,
                  notes,
                },
              });
              summary.anulados++;
              continue;
            }

            // Caso 1: OUT_OF_SCOPE
            if (outOfScopeTids.has(t.id)) {
              await tx.consolidado.create({
                data: {
                  tesoreriaMovementId: t.id,
                  status: "OUT_OF_SCOPE",
                  matchType: null,
                  outOfScopeReason: t.banco
                    ? `Sin alias configurado para "${t.banco}".`
                    : "Tesorería sin banco asignado.",
                },
              });
              summary.outOfScope++;
              continue;
            }

            // Caso 2b: glosa multipart "DEP (N) ..." => REVIEW manual.
            if (multiPartTids.has(t.id)) {
              const aliasAccount = aliasMap.get(t.banco!)!;
              await tx.consolidado.create({
                data: {
                  tesoreriaMovementId: t.id,
                  status: "REVIEW",
                  matchType: null,
                  resolvedAccountId: aliasAccount.id,
                  notes:
                    "Parte de un depósito agrupado (glosa con marcador). Vincular manualmente con las otras partes.",
                },
              });
              summary.review++;
              continue;
            }

            // Caso 3: con candidato asignado
            const cand = assignedByTid.get(t.id);
            if (cand) {
              const aliasAccount = aliasMap.get(t.banco!)!;
              const notes = exceptionTids.has(t.id)
                ? `⚠ Excepción API: la sucursal tiene "${t.banco}" asociado pero el depósito entró a otra cuenta/banco. Match cross-banco sugerido — confirmar.`
                : cand.isException
                ? `⚠ Excepción de banco: la API asignó "${t.banco}" pero el match real está en otra cuenta del mismo banco. Verificar.`
                : null;

              const consolidado = await tx.consolidado.create({
                data: {
                  tesoreriaMovementId: t.id,
                  status: cand.status,
                  matchType: cand.matchType,
                  score: Math.round(cand.score),
                  resolvedAccountId: cand.isException
                    ? cand.bms[0].accountId
                    : aliasAccount.id,
                  notes,
                },
              });

              // Solo AUTO_MATCHED se cuadra solo (crea los vinculos). SUGGESTED
              // y REVIEW quedan como PROPUESTA sin vincular: el status y score
              // marcan que hay un match probable, pero el usuario decide en el
              // detalle si lo cuadra ("Vincular") o lo descarta. El modal
              // recalcula los candidatos en vivo para estados abiertos.
              if (cand.status === "AUTO_MATCHED") {
                await tx.consolidadoLink.createMany({
                  data: cand.bms.map((bm) => ({
                    consolidadoId: consolidado.id,
                    bankMovementId: bm.id,
                  })),
                  skipDuplicates: true,
                });
              }

              switch (cand.status) {
                case "AUTO_MATCHED":
                  summary.autoMatched++;
                  break;
                case "SUGGESTED":
                  summary.suggested++;
                  break;
                case "REVIEW":
                  summary.review++;
                  break;
              }
              if (cand.bms.length > 1) summary.splits++;
              if (cand.isException) summary.exceptions++;
              continue;
            }

            // Caso 4: sin asignacion. Excepcion API sin candidato => REVIEW
            // (sigue marcada para atencion manual). Resto => NO_MATCH.
            const aliasAccount = aliasMap.get(t.banco!)!;
            if (exceptionTids.has(t.id)) {
              await tx.consolidado.create({
                data: {
                  tesoreriaMovementId: t.id,
                  status: "REVIEW",
                  matchType: null,
                  resolvedAccountId: aliasAccount.id,
                  notes:
                    "Excepción API (esExcepcion=true): depósito a otro banco. Sin candidato automático — vincular manualmente.",
                },
              });
              summary.review++;
              continue;
            }
            await tx.consolidado.create({
              data: {
                tesoreriaMovementId: t.id,
                status: "NO_MATCH",
                matchType: null,
                resolvedAccountId: aliasAccount.id,
              },
            });
            summary.noMatch++;
          }
        },
        { timeout: 60000 } // 60s, el wipe + insert masivo puede demorar
      );
    } catch (e) {
      summary.errors++;
      summary.ok = false;
      console.error(
        "[consolidados] error en transaccion",
        e instanceof Error ? e.message : e
      );
    }
  } else {
    // Dry run: contar lo que se haria sin escribir
    for (const t of processable) {
      if (anuladoTids.has(t.id)) {
        summary.anulados++;
        continue;
      }
      if (outOfScopeTids.has(t.id)) {
        summary.outOfScope++;
        continue;
      }
      if (multiPartTids.has(t.id)) {
        summary.review++;
        continue;
      }
      const cand = assignedByTid.get(t.id);
      if (cand) {
        switch (cand.status) {
          case "AUTO_MATCHED":
            summary.autoMatched++;
            break;
          case "SUGGESTED":
            summary.suggested++;
            break;
          case "REVIEW":
            summary.review++;
            break;
        }
        if (cand.bms.length > 1) summary.splits++;
        if (cand.isException) summary.exceptions++;
      } else if (exceptionTids.has(t.id)) {
        // Excepcion API sin candidato => REVIEW
        summary.review++;
      } else {
        summary.noMatch++;
      }
    }
  }

  summary.ms = Date.now() - t0;
  return summary;
}

/* ============== Compat: API legacy ============== */

/**
 * Mantenido por compatibilidad con /api/consolidados/[id]/route.ts.
 * Devuelve la cuenta resuelta por alias para mostrar candidatos en la UI
 * del detalle.
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

/** Re-exportado para que la API del detalle siga pudiendo computar score. */
export function scoreCandidate(
  t: TesoreriaMovement,
  bm: BankMovement
): { score: number; factors: ScoreFactor[] } {
  const { score, factors } = scoreOnePair(t, bm);
  return { score, factors };
}

/**
 * Gating de identidad para candidatos cross-cuenta (mismo gate que usa el
 * motor en el candidato tipo 3). True si hay match firme de nombre/RUT del
 * cliente o RUT/nombre embebido en la glosa (CLIENTE GENERICO). Se usa en el
 * detalle para no proponer abonos de otra cuenta por mera coincidencia de
 * monto entre bancos distintos.
 */
export function hasCrossAccountIdentity(
  t: TesoreriaMovement,
  bm: BankMovement
): boolean {
  return hasStrongNameOrRutMatch(t, bm) || glosaIdentityMatch(t, bm);
}
