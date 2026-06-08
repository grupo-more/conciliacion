import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/egresos/movements — lista EgresoMovement (gastos operativos).
 * Filtros: ?sucursalId ?rubroId ?since ?until ?q ?limit ?offset
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const sucursalId = url.searchParams.get("sucursalId");
  const rubroId = url.searchParams.get("rubroId");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const q = url.searchParams.get("q");
  const limit = clampInt(url.searchParams.get("limit"), 1, 5000, 500);
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

  const where: Prisma.EgresoMovementWhereInput = {};
  if (sucursalId) {
    const n = parseInt(sucursalId, 10);
    if (!Number.isNaN(n)) where.sucursalId = n;
  }
  if (rubroId) {
    const n = parseInt(rubroId, 10);
    if (!Number.isNaN(n)) where.rubroId = n;
  }
  if (since || until) {
    where.fecha = {};
    if (since) (where.fecha as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.fecha as Prisma.DateTimeFilter).lt = end;
    }
  }
  if (q && q.trim() !== "") {
    where.OR = [
      { glosa: { contains: q, mode: "insensitive" } },
      { sucursalName: { contains: q, mode: "insensitive" } },
      { cajeroName: { contains: q, mode: "insensitive" } },
      { rubroNombre: { contains: q, mode: "insensitive" } },
    ];
  }

  const [rows, total, sucursales, rubros, agg] = await Promise.all([
    prisma.egresoMovement.findMany({ where, orderBy: { fecha: "desc" }, take: limit, skip: offset }),
    prisma.egresoMovement.count({ where }),
    prisma.egresoMovement.groupBy({ by: ["sucursalId", "sucursalName"], orderBy: [{ sucursalId: "asc" }] }),
    prisma.egresoMovement.groupBy({ by: ["rubroId", "rubroNombre"], _count: { _all: true }, orderBy: [{ rubroId: "asc" }] }),
    prisma.egresoMovement.aggregate({ where, _sum: { monto: true } }),
  ]);

  return NextResponse.json({
    total,
    limit,
    offset,
    sumMonto: (agg._sum.monto ?? 0n).toString(),
    movements: rows.map((m) => ({
      id: m.id,
      externalId: m.externalId.toString(),
      fecha: m.fecha.toISOString(),
      monto: m.monto.toString(),
      glosa: m.glosa,
      sucursalId: m.sucursalId,
      sucursalName: m.sucursalName,
      cajeroUsername: m.cajeroUsername,
      cajeroName: m.cajeroName,
      rubroId: m.rubroId,
      rubroNombre: m.rubroNombre,
      fechaCarga: m.fechaCarga?.toISOString() ?? null,
    })),
    facets: {
      sucursales: sucursales.map((s) => ({ id: s.sucursalId, name: s.sucursalName })),
      rubros: rubros
        .filter((r) => r.rubroId !== null)
        .map((r) => ({ id: r.rubroId as number, nombre: r.rubroNombre, count: r._count._all })),
    },
  });
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
