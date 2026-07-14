export function formatMoney(amount: number | bigint, currency = "CLP"): string {
  const value = typeof amount === "bigint" ? Number(amount) : amount;
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/**
 * Muestra el fin de un rango que se ALMACENA como fin-EXCLUSIVO (día siguiente
 * al "Hasta" elegido, la convención de los rangos de la app). Resta 1 día para
 * mostrar el último día realmente incluido — ej: guardado 15-07 → muestra 14-07.
 */
export function formatDateRangeEnd(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : new Date(date);
  d.setDate(d.getDate() - 1);
  return formatDate(d);
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("es-CL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
