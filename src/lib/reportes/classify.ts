/**
 * Helpers compartidos del modulo Reportes.
 *
 * Tres ejes de clasificacion de lo "sin conciliar":
 *   - Rango de fecha (parseRange): default mes actual.
 *   - Aging (agingBucket): antiguedad del pendiente desde hoy, en buckets.
 *   - Lado banco (bankTag): por que esta sin conciliar / si espera contraparte.
 *   - Lado Dynatech (dynatechMotivo): por que el Consolidado no quedo cuadrado.
 *
 * "Conciliado" para reportes = existe un Consolidado en estado AUTO_MATCHED o
 * MANUAL vinculado. SUGGESTED/REVIEW/NO_MATCH/OUT_OF_SCOPE/sin-Consolidado
 * cuentan como sin conciliar (cada uno con su motivo).
 */

/** Estados que cuentan como "conciliado de verdad". */
export const CONCILIADO_STATUSES = ["AUTO_MATCHED", "MANUAL"] as const;

/* ============================== Rango ============================== */

export function parseRange(
  fromRaw: string | null,
  toRaw: string | null,
): { from: Date; to: Date } {
  if (fromRaw && toRaw) {
    const from = parseDateOnly(fromRaw);
    const to = parseDateOnly(toRaw);
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setDate(toEnd.getDate() + 1); // inclusivo en el dia "hasta"
      return { from, to: toEnd };
    }
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

function parseDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/* ============================== Aging ============================== */

export type AgingBucket = "0-7" | "8-30" | "31-60" | "60+";

export const AGING_BUCKETS: AgingBucket[] = ["0-7", "8-30", "31-60", "60+"];

export const AGING_LABEL: Record<AgingBucket, string> = {
  "0-7": "0-7 días",
  "8-30": "8-30 días",
  "31-60": "31-60 días",
  "60+": "+60 días",
};

/** Dias calendario entre `date` y `ref` (hoy), y su bucket. Nunca negativo. */
export function agingBucket(
  date: Date,
  ref: Date,
): { days: number; bucket: AgingBucket } {
  const d0 = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const r0 = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const days = Math.max(
    0,
    Math.round((r0.getTime() - d0.getTime()) / 86_400_000),
  );
  let bucket: AgingBucket = "0-7";
  if (days > 60) bucket = "60+";
  else if (days > 30) bucket = "31-60";
  else if (days > 7) bucket = "8-30";
  return { days, bucket };
}

/* ========================= Tag lado banco ========================= */

/**
 * Clasifica una salida/entrada bancaria sin conciliar segun si ESPERA tener
 * contraparte en Dynatech. La idea es separar el ruido esperado (traspasos
 * internos, settlements Transbank, comisiones) de la brecha real.
 */
export type BankTag = "interno" | "transbank" | "comision" | "sin_clasificar";

export const BANK_TAG_LABEL: Record<BankTag, string> = {
  interno: "Interno",
  transbank: "Transbank",
  comision: "Comisión / cargo",
  sin_clasificar: "Sin clasificar",
};

// Transbank / abonos de tarjetas (settlement, no van al motor de ingresos).
const TRANSBANK_RE = /\b(transbank|redbank|t\.?b\.?k)\b/i;
// Comisiones, mantenciones, impuestos y cargos del propio banco.
const COMISION_RE =
  /(comisi[oó]n|mantenci[oó]n|impuesto|iva\b|cargo\b|gasto\s+banc|cobro\b)/i;

/** `esInterno` lo decide el caller (detectInterno !== null), por orden de confianza. */
export function bankTag(
  esInterno: boolean,
  description: string | null | undefined,
  counterpartyName: string | null | undefined,
): BankTag {
  if (esInterno) return "interno";
  const hay = `${description ?? ""} ${counterpartyName ?? ""}`;
  if (TRANSBANK_RE.test(hay)) return "transbank";
  if (COMISION_RE.test(hay)) return "comision";
  return "sin_clasificar";
}

/* ======================= Motivo lado Dynatech ======================= */

/**
 * Por que un TesoreriaMovement no quedo conciliado. Se deriva del status del
 * Consolidado (null = nunca proceso). AUTO_MATCHED/MANUAL no deberian llegar
 * aca (se filtran antes), pero por defensa caen en "sin_procesar".
 */
export type DynatechMotivo =
  | "sin_procesar"
  | "sugerido"
  | "revisar"
  | "excepcion"
  | "sin_match"
  | "fuera_scope";

export const MOTIVO_LABEL: Record<DynatechMotivo, string> = {
  sin_procesar: "Sin procesar",
  sugerido: "Sugerido pendiente",
  revisar: "Revisar",
  excepcion: "Excepción API",
  sin_match: "Sin match",
  fuera_scope: "Fuera de scope",
};

/** Pista de accion para cada motivo — se muestra en la UI/Excel. */
export const MOTIVO_ACCION: Record<DynatechMotivo, string> = {
  sin_procesar: "Correr 'Re-evaluar todo'",
  sugerido: "Revisar y confirmar en Lista",
  revisar: "Revisar candidatos en Lista",
  excepcion: "Depósito a otro banco — revisar cross-banco",
  sin_match: "Falta cartola o no hay contraparte",
  fuera_scope: "Configurar alias del banco",
};

export function dynatechMotivo(
  status: string | null | undefined,
  esExcepcion: boolean,
): DynatechMotivo {
  if (!status || status === "UNPROCESSED") return "sin_procesar";
  switch (status) {
    case "SUGGESTED":
      return "sugerido";
    case "REVIEW":
      return esExcepcion ? "excepcion" : "revisar";
    case "NO_MATCH":
      return "sin_match";
    case "OUT_OF_SCOPE":
      return "fuera_scope";
    default:
      return "sin_procesar";
  }
}
