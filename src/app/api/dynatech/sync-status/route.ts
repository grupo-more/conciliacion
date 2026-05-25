import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/dynatech/sync-status
 *
 * Devuelve info del último sync (OK o ERROR), conteo total de movimientos
 * y rango de fechas cubierto por los datos en BD.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const [lastOk, lastAny, totalMovements, dateRange] = await Promise.all([
    prisma.dynatechSyncRun.findFirst({
      where: { status: "OK" },
      orderBy: { finishedAt: "desc" },
    }),
    prisma.dynatechSyncRun.findFirst({
      orderBy: { startedAt: "desc" },
    }),
    prisma.dynatechMovement.count(),
    prisma.dynatechMovement.aggregate({
      _min: { occurredAt: true },
      _max: { occurredAt: true },
    }),
  ]);

  return NextResponse.json({
    lastOk: lastOk
      ? {
          id: lastOk.id,
          finishedAt: lastOk.finishedAt?.toISOString() ?? null,
          fetchedRows: lastOk.fetchedRows,
          insertedRows: lastOk.insertedRows,
          skippedDuplicates: lastOk.skippedDuplicates,
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
    dateRange: {
      from: dateRange._min.occurredAt?.toISOString() ?? null,
      to: dateRange._max.occurredAt?.toISOString() ?? null,
    },
  });
}
