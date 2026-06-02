/**
 * Detección de abonos Transbank en cartolas bancarias.
 *
 * Patrón: los movimientos de liquidación de Transbank entran al banco con una
 * glosa que contiene "ABN CRD" + "TRANSBA" (ej. "0966893109 ABN CRD DB TRAN TRANSBA").
 * Son siempre IN (abonos). NO tienen contraparte en Tesorería — no son ventas
 * de sucursal sino liquidaciones de tarjetas — y por eso quedan eternamente
 * sin match en el flujo normal de Consolidados.
 *
 * El módulo "Abono Transbank" arma un asiento contable directo sobre estos
 * BankMovements: Debe rubro banco (230) / Haber rubro Transbank (17).
 */

/** Rubro contable del lado banco para abonos Transbank (lado Debe). */
export const TRANSBANK_RUBRO_BANCO = 230;

/** Rubro contable de la contracuenta Transbank por liquidar (lado Haber). */
export const TRANSBANK_RUBRO_CONTRA = 17;

/**
 * Predicado JS: el movimiento es un abono Transbank.
 * Se mira la glosa case-insensitive — debe contener "abn crd" Y "transba"
 * y la dirección debe ser IN.
 */
export function isTransbank(m: {
  description: string | null | undefined;
  direction: string;
}): boolean {
  if (m.direction !== "IN") return false;
  const d = (m.description ?? "").toLowerCase();
  return d.includes("abn crd") && d.includes("transba");
}

/**
 * Cláusula Prisma equivalente a isTransbank() para usar dentro de un `where`.
 * Compón con AND/OR según el caso de uso.
 */
export const transbankPrismaWhere = {
  direction: "IN" as const,
  AND: [
    { description: { contains: "abn crd", mode: "insensitive" as const } },
    { description: { contains: "transba", mode: "insensitive" as const } },
  ],
};

/**
 * Fragmento SQL ILIKE equivalente a isTransbank(). Se usa en queries crudos
 * (ej. el summary aggregate de /api/bank-movements). Aplica sobre la columna
 * `description` y `direction` de la tabla aliased como `bm`.
 *
 * IMPORTANTE: no incluye el alias — el caller compone con el alias correcto.
 * Devuelve un string para concatenar dentro de una sentencia Prisma.sql, pero
 * como el patrón es estático no hay riesgo de inyección.
 */
export const TRANSBANK_SQL_PREDICATE =
  `direction = 'IN' AND description ILIKE '%abn crd%' AND description ILIKE '%transba%'`;
