/**
 * Movimientos de Tesorería FUERA DE ALCANCE: no se concilian ni se muestran en
 * el flujo de Consolidados (Lista / Comparar), igual que las ventas TBK.
 *
 * Caso actual: las "COMPRA CUENTA APP MORE GIROS F####" — egresos que vienen de
 * /api/dynatech (claseOperacion=COMPRA_MONEDA, cliente MORE GIROS SPA, sucursal
 * TESORERIA, banco=null). Son compras de cuenta de la app propia; el negocio NO
 * las trabaja en conciliación bancaria, así que se omiten por completo para que
 * no generen ruido "fuera de scope".
 *
 * Se discrimina por PREFIJO de glosa (distintivo y estable). Si en el futuro hay
 * que omitir más casos, agregar acá y se propaga a motor + vistas.
 */

/** Prefijo de glosa de los movimientos fuera de alcance. */
export const FUERA_ALCANCE_GLOSA_PREFIX = "COMPRA CUENTA APP MORE GIROS";

/**
 * Fragmento Prisma para EXCLUIR los fuera-de-alcance de un
 * TesoreriaMovementWhereInput. Spread en el `where`:
 *   where: { ...otrosFiltros, ...excluirFueraAlcanceWhere }
 */
export const excluirFueraAlcanceWhere = {
  NOT: {
    glosa: {
      startsWith: FUERA_ALCANCE_GLOSA_PREFIX,
      mode: "insensitive" as const,
    },
  },
};

/** Predicado JS equivalente (para filtrar en memoria si hace falta). */
export function esFueraAlcance(glosa: string | null | undefined): boolean {
  return (
    !!glosa &&
    glosa.trimStart().toUpperCase().startsWith(FUERA_ALCANCE_GLOSA_PREFIX)
  );
}
