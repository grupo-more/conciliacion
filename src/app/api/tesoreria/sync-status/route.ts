import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/tesoreria/sync-status
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const [lastOk, lastAny, totalMovements, dateRange, excepciones] = await Promise.all([
    prisma.tesoreriaSyncRun.findFirst({
      where: { status: "OK" },
      orderBy: { finishedAt: "desc" },
    }),
    prisma.tesoreriaSyncRun.findFirst({
      orderBy: { startedAt: "desc" },
    }),
    prisma.tesoreriaMovement.count(),
    prisma.tesoreriaMovement.aggregate({
      _min: { fecha: true },
      _max: { fecha: true },
    }),
    prisma.tesoreriaMovement.count({ where: { esExcepcion: true } }),
  ]);

  return NextResponse.json({
    lastOk: lastOk
      ? {
          id: lastOk.id,
          finishedAt: lastOk.finishedAt?.toISOString() ?? null,
          fetchedRows: lastOk.fetchedRows,
          insertedRows: lastOk.insertedRows,
          updatedRows: lastOk.updatedRows,
          skippedInvalid: lastOk.skippedInvalid,
          fetchMs: lastOk.fetchMs,
        }
      : null,
    lastAny: lastAny
      ? {
          id: lastAny.id,
          status: lastAny.status,
          startedAt: lastAny.startedAt.toISOString(),
          finishedAt: lastAny.finishedAt?.toISOString() ?? null,
          errorMessage: lastAny.errorMessage,
        }
      : null,
    totalMovements,
    totalExcepciones: excepciones,
    dateRange: {
      from: dateRange._min.fecha?.toISOString() ?? null,
      to: dateRange._max.fecha?.toISOString() ?? null,
    },
  });
}
