/**
 * Utilidades para normalizar campos heterogéneos de cartolas bancarias.
 */

/**
 * Convierte un valor de monto que puede venir en formatos:
 *   "$213,600"  → 213600
 *   "-47,600"   → -47600
 *   "1.979.839" → 1979839 (formato chileno con punto como miles)
 *   "  916,000  " → 916000
 *   213600 (number) → 213600
 *   null/"" → null
 */
export function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw);
  }
  let s = String(raw).trim();
  if (!s) return null;

  // Detectar signo negativo
  const negative = s.startsWith("-") || s.startsWith("(");
  s = s.replace(/[()$\s]/g, "");
  if (s.startsWith("-")) s = s.slice(1);

  // Decidir separador de miles: en Chile suelen usar punto o coma como miles.
  // No hay decimales en CLP, así que removemos ambos.
  s = s.replace(/[.,]/g, "");

  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Parsea una fecha en formatos chilenos comunes:
 *   "04/05/2026", "4/5/2026", "04-05-2026"
 *   "2026-05-04"
 *   Date (de xlsx con cellDates: true)
 */
export function parseDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw;
  }
  const s = String(raw).trim();
  if (!s) return null;

  // ISO: 2026-05-04 o 2026-05-04T...
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
  const isoMatch = s.match(iso);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }

  // dd/mm/yyyy o dd-mm-yyyy
  const dmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/;
  const dmyMatch = s.match(dmy);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return new Date(year, Number(m) - 1, Number(d));
  }

  return null;
}

/**
 * Combina fecha + hora ("HH:MM") en un Date. Si la hora es inválida, devuelve solo la fecha.
 */
export function combineDateTime(date: Date | null, hhmm: unknown): Date | null {
  if (!date) return null;
  if (hhmm === null || hhmm === undefined || hhmm === "") return date;
  const s = String(hhmm).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return date;
  const out = new Date(date);
  out.setHours(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
  return out;
}

/**
 * Normaliza un RUT chileno: deja "12345678-9" en mayúsculas, sin puntos ni espacios.
 */
export function normalizeRut(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim().toUpperCase().replace(/[.\s]/g, "");
  if (!s) return null;
  // Aceptar formatos: 12345678-9 o 12345678K
  const m = s.match(/^(\d{1,9})-?([0-9K])$/);
  if (!m) return s; // devolver lo que sea, normalizado mínimamente
  return `${m[1]}-${m[2]}`;
}

/**
 * Normaliza un número de cuenta: solo dígitos, sin ceros a la izquierda redundantes.
 */
export function normalizeAccountNumber(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, "");
  // Remover ceros a la izquierda pero dejar al menos un dígito
  return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Normaliza una glosa para deduplicación: lowercase, sin espacios redundantes,
 * elimina prefijos numéricos típicos de Santander tipo "0085668013 Transf. CA".
 */
export function normalizeDescription(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/\s+/g, " ");
  return s;
}

/**
 * Hashea un string a hex SHA-256 (truncado a 16 caracteres para legibilidad).
 */
export function shortHash(input: string): string {
  // Usamos crypto de node, que está disponible en server y scripts.
  // Import dinámico para no romper builds donde no esté.
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * Lee una celda como string, devolviendo "" para null/undefined.
 */
export function asStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Indica si una fila completa está vacía (todas sus celdas null/"").
 */
export function isEmptyRow(row: unknown[] | undefined | null): boolean {
  if (!row) return true;
  return row.every(
    (c) => c === null || c === undefined || (typeof c === "string" && c.trim() === "")
  );
}
