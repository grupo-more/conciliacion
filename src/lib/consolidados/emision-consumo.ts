import { prisma } from "@/lib/db";

/**
 * Referencias (bankMovementId / consolidadoId) ya consumidas por emisiones de
 * una tab derivada. Se usa SOLO para excluir filas del listado de esa tab —
 * los motores de matching y banco-compute (Reportes) no consultan esto:
 * un movimiento emitido sigue contando como resuelto en todo el sistema.
 */
export async function consumedRefIds(
  origen: "OK" | "ABONO_TRANSBANK" | "DIF_MENOR" | "DIF_MENOR_EGRESO" | "TRASPASOS_INTERNOS",
): Promise<Set<string>> {
  const rows = await prisma.emisionConsumo.findMany({
    where: { emision: { origen } },
    select: { refId: true },
  });
  return new Set(rows.map((r) => r.refId));
}
