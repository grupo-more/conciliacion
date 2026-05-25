/**
 * Sistema de scoring para conciliación.
 *
 * Reemplaza las decisiones binarias (if/else) por un score 0-100 trazable
 * que combina todas las señales disponibles. Cada factor es explícito y
 * ajustable; los pesos se definen aquí y todo el sistema deriva del mismo lugar.
 *
 *   ≥ 80 → AUTO_MATCHED
 *   60-79 → SUGGESTED
 *   40-59 → REVIEW
 *   < 40 → NO_MATCH (descartado para sugerir)
 *
 * Importante: los pesos están calibrados a mano sobre el comportamiento
 * esperado, no aprendidos de datos. Si en el futuro hay 500+ matches
 * confirmados, puede migrarse a regresión logística manteniendo la misma
 * estructura de factores (cambia solo el origen de los pesos).
 */

import type { BankMovement, DynatechMovement } from "@prisma/client";
import { parseGlosa, type GlosaParsed } from "./glosa";

/* ─────────────────────────── Configuración ─────────────────────────── */

export const SCORE_THRESHOLDS = {
  AUTO_MATCHED: 80,
  SUGGESTED: 60,
  REVIEW: 40,
} as const;

export const SCORE_WEIGHTS = {
  // Monto (precondición: si no hay match exacto, no se evalúa)
  amount_exact: 30,

  // Fecha
  same_day: 20,
  diff_1d: 15,
  diff_2d: 10,
  diff_3_7d: 5,

  // RUT (la evidencia más fuerte)
  rut_match: 35,
  rut_contradicts: -100, // anula el match (queda <0, va a REVIEW por contradicción)

  // Nombre
  name_high: 20, // ≥0.8
  name_mid: 12, // 0.5-0.79
  name_contradicts: -50, // <0.2 con ambos nombres presentes

  // Glosa
  glosa_bank: 8,
  glosa_holder: 8,
  glosa_giro: 5,

  // Filtros que ya redujeron candidatos
  hint_applies: 10,
  history_branch: 5,

  // Patrones aprendidos (cliente/cajero → cuenta)
  history_client_account: 15, // mismo cliente fue a esa cuenta antes (≥80%)
  history_client_bank: 8, // mismo cliente al menos al mismo banco
  history_client_name_account: 10, // cliente por nombre fue a esa cuenta
  history_cashier_account: 5,

  // Coherencia temporal
  temporal_after_venta: 5, // el abono es posterior a la venta (lógico)
  temporal_before_venta: -20, // el abono es anterior a la venta (sospechoso)
} as const;

export const NAME_THRESHOLDS = {
  HIGH: 0.5,
  MID: 0.3,
  CONTRADICTS: 0.2,
} as const;

/* ───────────────────────────── Tipos ───────────────────────────────── */

export interface ScoreFactor {
  key: keyof typeof SCORE_WEIGHTS;
  label: string;
  weight: number;
  detail?: string;
}

export interface ScoreResult {
  total: number;
  factors: ScoreFactor[];
  /** Estado sugerido según los umbrales. No incluye REVIEW por contradicción */
  suggestedStatus: "AUTO_MATCHED" | "SUGGESTED" | "REVIEW" | "NO_MATCH";
  /** Razón si el score fue forzado a REVIEW por contradicción dura */
  hardContradiction: string | null;
}

export interface HistoryPatterns {
  /** Cliente (RUT) → cuenta más usada en matches confirmados */
  clientAccount: Map<string, { accountId: string; ratio: number; total: number }>;
  /** Cliente (RUT) → banco más usado */
  clientBank: Map<string, { bankCode: string; ratio: number; total: number }>;
  /** Cliente (nombre normalizado) → cuenta más usada */
  clientNameAccount: Map<string, { accountId: string; ratio: number; total: number }>;
  /** Cajero (username) → cuenta más usada */
  cashierAccount: Map<string, { accountId: string; ratio: number; total: number }>;
}

/* ──────────────────────── Helpers de comparación ───────────────────── */

export function normalizeNameTokens(name: string): Set<string> {
  const cleaned = name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-ZÑ\s]/g, " ")
    .replace(
      /\b(?:DE|DEL|LA|LOS|LAS|EL|Y|SR|SRA|DON|DONA|TRANSFERENCIA|TRANSF|RECIBIDA|RECIBE|DEPOSITO|DEP|TRASPASO|TRANSP|PARA|POR|DESDE|HACIA)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
  return new Set(cleaned.split(" ").filter((w) => w.length >= 3));
}

export function nameMatchRatio(
  bankName: string | null,
  dynName: string | null
): number | null {
  if (!bankName || !dynName) return null;
  const bankTokens = normalizeNameTokens(bankName);
  const dynTokens = normalizeNameTokens(dynName);
  if (bankTokens.size === 0 || dynTokens.size === 0) return null;
  let inter = 0;
  for (const t of bankTokens) if (dynTokens.has(t)) inter++;
  return inter / bankTokens.size;
}

/** Clave normalizada para asociar nombre Dyn → cuenta histórica */
export function nameHistoryKey(name: string | null): string | null {
  if (!name) return null;
  const tokens = [...normalizeNameTokens(name)].sort();
  if (tokens.length === 0) return null;
  return tokens.join("|");
}

function stripTime(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/* ──────────────────────── Cálculo del score ────────────────────────── */

export interface ScoreInputs {
  dyn: Pick<
    DynatechMovement,
    | "customerRut"
    | "customerName"
    | "occurredAt"
    | "observation"
    | "totalAmount"
    | "cashierUsername"
    | "branchExternalId"
  >;
  bank: Pick<
    BankMovement,
    | "counterpartyRut"
    | "counterpartyName"
    | "postDate"
    | "transactionDate"
    | "amount"
    | "accountId"
  >;
  accountBankCode: string;
  glosa?: GlosaParsed;
  /** Si la cuenta del bank coincide con el hint manual de la sucursal */
  hintAppliesToThisAccount?: boolean;
  /** Si la cuenta coincide con la cuenta más usada por la sucursal en historial */
  historyBranchMatchesThisAccount?: boolean;
  /** Patrones de historial (computados a nivel de run) */
  patterns?: HistoryPatterns;
}

export function computeScore(input: ScoreInputs): ScoreResult {
  const { dyn, bank, accountBankCode } = input;
  const factors: ScoreFactor[] = [];
  let hardContradiction: string | null = null;

  function add(key: keyof typeof SCORE_WEIGHTS, label: string, detail?: string) {
    factors.push({
      key,
      label,
      weight: SCORE_WEIGHTS[key],
      detail,
    });
  }

  // ─── Monto: precondición. Si no es exacto, no entra en el flujo de score.
  if (bank.amount !== dyn.totalAmount) {
    return {
      total: 0,
      factors: [],
      suggestedStatus: "NO_MATCH",
      hardContradiction: null,
    };
  }
  add("amount_exact", "Monto exacto");

  // ─── Fecha
  const occ = stripTime(dyn.occurredAt);
  const post = stripTime(bank.postDate);
  const dayDiff = Math.abs(diffDays(post, occ));
  if (dayDiff === 0) add("same_day", "Mismo día");
  else if (dayDiff === 1) add("diff_1d", "±1 día");
  else if (dayDiff === 2) add("diff_2d", "±2 días");
  else if (dayDiff <= 7) add("diff_3_7d", `±${dayDiff} días`);
  // >7 días no suma nada

  // ─── RUT
  const rutDyn = dyn.customerRut;
  const rutBank = bank.counterpartyRut;
  if (rutDyn && rutBank) {
    if (rutDyn === rutBank) {
      add("rut_match", "RUT cliente coincide");
    } else {
      add("rut_contradicts", "RUT no coincide", `Dyn ${rutDyn} vs banco ${rutBank}`);
      hardContradiction = `RUTs distintos: ${rutDyn} vs ${rutBank}`;
    }
  }

  // ─── Nombre
  const ratio = nameMatchRatio(bank.counterpartyName, dyn.customerName);
  if (ratio !== null) {
    if (ratio >= NAME_THRESHOLDS.HIGH) {
      add("name_high", "Nombre coincide", `${Math.round(ratio * 100)}%`);
    } else if (ratio >= NAME_THRESHOLDS.MID) {
      add("name_mid", "Nombre similar", `${Math.round(ratio * 100)}%`);
    } else if (ratio < NAME_THRESHOLDS.CONTRADICTS) {
      add("name_contradicts", "Nombre distinto", `${Math.round(ratio * 100)}%`);
      if (!hardContradiction) {
        hardContradiction = `Nombres distintos: "${bank.counterpartyName}" vs "${dyn.customerName}"`;
      }
    }
    // entre CONTRADICTS y MID: no suma ni resta (zona ambigua)
  }

  // ─── Glosa
  const glosa = input.glosa ?? parseGlosa(dyn.observation || "");
  if (glosa.bank) add("glosa_bank", `Glosa identifica banco`, glosa.bank);
  if (glosa.holder) add("glosa_holder", `Glosa identifica titular`, glosa.holder);
  if (glosa.giroNumber) add("glosa_giro", `Glosa menciona giro`, `#${glosa.giroNumber}`);

  // ─── Hint manual de sucursal
  if (input.hintAppliesToThisAccount) {
    add("hint_applies", "Hint sucursal aplica");
  }

  // ─── Historial por sucursal
  if (input.historyBranchMatchesThisAccount) {
    add("history_branch", "Historial sucursal respalda");
  }

  // ─── Patrones aprendidos (cliente, cajero)
  const patterns = input.patterns;
  if (patterns) {
    if (rutDyn) {
      const ca = patterns.clientAccount.get(rutDyn);
      if (ca && ca.accountId === bank.accountId && ca.ratio >= 0.8 && ca.total >= 3) {
        add(
          "history_client_account",
          "Cliente suele depositar aquí",
          `${ca.total} matches previos · ${Math.round(ca.ratio * 100)}%`
        );
      } else {
        const cb = patterns.clientBank.get(rutDyn);
        if (
          cb &&
          cb.bankCode === accountBankCode &&
          cb.ratio >= 0.8 &&
          cb.total >= 3
        ) {
          add(
            "history_client_bank",
            "Cliente suele usar este banco",
            `${cb.total} matches · ${Math.round(cb.ratio * 100)}%`
          );
        }
      }
    } else {
      // Cliente genérico: probar por nombre
      const nameKey = nameHistoryKey(dyn.customerName);
      if (nameKey) {
        const cn = patterns.clientNameAccount.get(nameKey);
        if (cn && cn.accountId === bank.accountId && cn.ratio >= 0.8 && cn.total >= 2) {
          add(
            "history_client_name_account",
            "Cliente por nombre suele depositar aquí",
            `${cn.total} matches`
          );
        }
      }
    }

    const cashHist = patterns.cashierAccount.get(dyn.cashierUsername);
    if (
      cashHist &&
      cashHist.accountId === bank.accountId &&
      cashHist.ratio >= 0.75 &&
      cashHist.total >= 10
    ) {
      add(
        "history_cashier_account",
        "Cajero suele operar aquí",
        `${cashHist.total} matches · ${Math.round(cashHist.ratio * 100)}%`
      );
    }
  }

  // ─── Coherencia temporal
  // Si la cartola trae transactionDate con hora útil, usar eso; si no, comparar día.
  const txDate = bank.transactionDate ?? bank.postDate;
  const ventaMs = dyn.occurredAt.getTime();
  const abonoMs = txDate.getTime();
  const sameDayLogical = dayDiff === 0;

  if (sameDayLogical && abonoMs < ventaMs) {
    add(
      "temporal_before_venta",
      "Abono anterior a la venta",
      "Imposible que sea esta venta"
    );
    if (!hardContradiction) {
      hardContradiction = "El abono ocurrió antes que la venta misma";
    }
  } else if (dayDiff <= 1 && abonoMs >= ventaMs) {
    add("temporal_after_venta", "Abono posterior a la venta");
  }

  // ─── Total
  const total = factors.reduce((acc, f) => acc + f.weight, 0);

  // ─── Decisión
  let suggestedStatus: ScoreResult["suggestedStatus"];
  if (hardContradiction) {
    // Contradicción dura → REVIEW, ignora el score
    suggestedStatus = "REVIEW";
  } else if (total >= SCORE_THRESHOLDS.AUTO_MATCHED) {
    suggestedStatus = "AUTO_MATCHED";
  } else if (total >= SCORE_THRESHOLDS.SUGGESTED) {
    suggestedStatus = "SUGGESTED";
  } else if (total >= SCORE_THRESHOLDS.REVIEW) {
    suggestedStatus = "REVIEW";
  } else {
    suggestedStatus = "NO_MATCH";
  }

  return { total, factors, suggestedStatus, hardContradiction };
}

/* ──────────────────── Cómputo de patrones desde BD ────────────────── */

import { prisma } from "@/lib/db";

/**
 * Calcula los patrones aprendidos de los matches confirmados
 * (AUTO_MATCHED + MANUAL). Se ejecuta una vez por run de matching.
 */
export async function computeHistoryPatterns(): Promise<HistoryPatterns> {
  const confirmedMatches = await prisma.reconciliation.findMany({
    where: { status: { in: ["AUTO_MATCHED", "MANUAL"] } },
    include: {
      dynatechMovement: {
        select: {
          customerRut: true,
          customerName: true,
          cashierUsername: true,
        },
      },
      links: {
        include: {
          bankMovement: {
            select: {
              accountId: true,
              account: { select: { bankCode: true } },
            },
          },
        },
      },
    },
  });

  // Agregadores: {key → {accountId/bankCode → count}}
  const aggClientAccount = new Map<string, Map<string, number>>();
  const aggClientBank = new Map<string, Map<string, number>>();
  const aggClientNameAccount = new Map<string, Map<string, number>>();
  const aggCashierAccount = new Map<string, Map<string, number>>();

  function bump(map: Map<string, Map<string, number>>, key: string, val: string) {
    const inner = map.get(key) ?? new Map<string, number>();
    inner.set(val, (inner.get(val) ?? 0) + 1);
    map.set(key, inner);
  }

  for (const r of confirmedMatches) {
    const dyn = r.dynatechMovement;
    for (const link of r.links) {
      const accountId = link.bankMovement.accountId;
      const bankCode = link.bankMovement.account.bankCode;

      if (dyn.customerRut) {
        bump(aggClientAccount, dyn.customerRut, accountId);
        bump(aggClientBank, dyn.customerRut, bankCode);
      } else {
        const nameKey = nameHistoryKey(dyn.customerName);
        if (nameKey) bump(aggClientNameAccount, nameKey, accountId);
      }
      bump(aggCashierAccount, dyn.cashierUsername, accountId);
    }
  }

  function pickBest<T extends string>(
    agg: Map<string, Map<string, number>>
  ): Map<string, { value: T; ratio: number; total: number }> {
    const out = new Map<string, { value: T; ratio: number; total: number }>();
    for (const [key, inner] of agg) {
      let best: T | null = null;
      let bestCount = 0;
      let total = 0;
      for (const [v, n] of inner) {
        total += n;
        if (n > bestCount) {
          best = v as T;
          bestCount = n;
        }
      }
      if (best) out.set(key, { value: best, ratio: bestCount / total, total });
    }
    return out;
  }

  const clientAccountBest = pickBest<string>(aggClientAccount);
  const clientBankBest = pickBest<string>(aggClientBank);
  const clientNameAccountBest = pickBest<string>(aggClientNameAccount);
  const cashierAccountBest = pickBest<string>(aggCashierAccount);

  return {
    clientAccount: new Map(
      [...clientAccountBest].map(([k, v]) => [k, { accountId: v.value, ratio: v.ratio, total: v.total }])
    ),
    clientBank: new Map(
      [...clientBankBest].map(([k, v]) => [k, { bankCode: v.value, ratio: v.ratio, total: v.total }])
    ),
    clientNameAccount: new Map(
      [...clientNameAccountBest].map(([k, v]) => [k, { accountId: v.value, ratio: v.ratio, total: v.total }])
    ),
    cashierAccount: new Map(
      [...cashierAccountBest].map(([k, v]) => [k, { accountId: v.value, ratio: v.ratio, total: v.total }])
    ),
  };
}
