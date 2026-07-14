import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { transbankPrismaWhere } from "@/lib/transbank/detect";

/**
 * DIAGNÓSTICO TEMPORAL — /api/consolidados/abono-transbank/diag
 *
 * Read-only. Responde por qué los abonos Transbank emitidos no desaparecen de
 * "Por emitir". Compara los refId que las emisiones consumieron contra los
 * BankMovement que existen HOY. Si hay refId "huérfanos" (apuntan a un id que
 * ya no existe), la causa es que los movimientos cambiaron de id (re-import).
 *
 * Borrar este archivo cuando terminemos de diagnosticar.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  // 1) Emisiones de Abono Transbank + sus consumos (refId = bankMovementId al emitir).
  const emisiones = await prisma.emisionAsientos.findMany({
    where: { origen: "ABONO_TRANSBANK" },
    orderBy: { folio: "asc" },
    select: { id: true, folio: true, desde: true, hasta: true, count: true },
  });
  const consumos = await prisma.emisionConsumo.findMany({
    where: { emision: { origen: "ABONO_TRANSBANK" } },
    select: { refId: true, emisionId: true },
  });
  const consumedIds = consumos.map((c) => c.refId);

  // 2) ¿Cuántos de esos refId todavía existen como BankMovement?
  const existentes =
    consumedIds.length > 0
      ? await prisma.bankMovement.findMany({
          where: { id: { in: consumedIds } },
          select: { id: true },
        })
      : [];
  const existentesSet = new Set(existentes.map((m) => m.id));
  const huerfanos = consumedIds.filter((id) => !existentesSet.has(id));

  // 3) Abonos Transbank actuales (últimos 120 días) y si su id está consumido.
  const desde = new Date();
  desde.setDate(desde.getDate() - 120);
  const movs = await prisma.bankMovement.findMany({
    where: { ...transbankPrismaWhere, descartadoAt: null, postDate: { gte: desde } },
    select: { id: true, postDate: true, amount: true, description: true, accountId: true },
    orderBy: { postDate: "desc" },
    take: 500,
  });
  const consumedSet = new Set(consumedIds);
  const noConsumidos = movs.filter((m) => !consumedSet.has(m.id));

  const veredicto =
    consumedIds.length === 0
      ? "NO hay consumos ABONO_TRANSBANK en la base: las emisiones no consumieron nada (revisar el emitir)."
      : huerfanos.length > 0
        ? `HUÉRFANOS: ${huerfanos.length} de ${consumedIds.length} refId de emisión apuntan a movimientos que YA NO EXISTEN. Los ids cambiaron (borrado + re-import de la cartola) → por eso los actuales no se excluyen.`
        : "Todos los refId consumidos existen. Si igual reaparecen, el problema NO es orfandad — avisar para revisar la exclusión.";

  return NextResponse.json({
    veredicto,
    resumen: {
      emisiones: emisiones.length,
      refIdsConsumidos: consumedIds.length,
      refIdsHuerfanos: huerfanos.length,
      movimientosActuales: movs.length,
      movimientosActualesNoConsumidos: noConsumidos.length,
    },
    emisiones: emisiones.map((e) => ({
      folio: e.folio,
      desde: e.desde.toISOString().slice(0, 10),
      hasta: e.hasta.toISOString().slice(0, 10),
      count: e.count,
      consumos: consumos.filter((c) => c.emisionId === e.id).length,
    })),
    // Muestra de movimientos actuales que NO están consumidos (los que reaparecen).
    ejemplosNoConsumidos: noConsumidos.slice(0, 15).map((m) => ({
      id: m.id,
      fecha: m.postDate.toISOString().slice(0, 10),
      monto: m.amount.toString(),
      glosa: (m.description ?? "").slice(0, 40),
    })),
    // Muestra de refId huérfanos (ids que la emisión recuerda pero ya no existen).
    ejemplosHuerfanos: huerfanos.slice(0, 15),
  });
}
