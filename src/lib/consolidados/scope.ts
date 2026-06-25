/**
 * Movimientos de Tesorería FUERA DE ALCANCE: no se concilian ni se muestran en
 * el flujo de Consolidados (Lista / Comparar), igual que las ventas TBK.
 *
 * Son casos PUNTUALES (lista explícita por glosa) de MORE GIROS SPA fondeando su
 * propia app/cuentas, que NO se trabajan en conciliación bancaria. Para sumar
 * otro caso, agregarlo a FUERA_ALCANCE_GLOSAS (prefijo de glosa exacto).
 *
 * NO se generaliza a "COMPRA CUENTA …" ni a toda compra de moneda: solo lo
 * listado acá. (Ej.: "COMPRA USDC TRANSF TERRAPAY" SÍ se trabaja.)
 */

/** Prefijos de glosa EXACTOS a excluir (case-insensitive). */
export const FUERA_ALCANCE_GLOSAS = [
  "COMPRA CUENTA APP MORE GIROS",
  "COMPRA CUENTA REF TRANSF TERRAPAY",
];

/**
 * Fragmento Prisma para EXCLUIR los fuera-de-alcance de un
 * TesoreriaMovementWhereInput. Spread en el `where`:
 *   where: { ...otrosFiltros, ...excluirFueraAlcanceWhere }
 * (NOT de un OR: excluye filas cuya glosa empiece con cualquiera de la lista.)
 */
export const excluirFueraAlcanceWhere = {
  NOT: {
    OR: FUERA_ALCANCE_GLOSAS.map((g) => ({
      glosa: { startsWith: g, mode: "insensitive" as const },
    })),
  },
};

/** Predicado JS equivalente (para filtrar en memoria si hace falta). */
export function esFueraAlcance(glosa: string | null | undefined): boolean {
  if (!glosa) return false;
  const g = glosa.trimStart().toUpperCase();
  return FUERA_ALCANCE_GLOSAS.some((p) => g.startsWith(p));
}
