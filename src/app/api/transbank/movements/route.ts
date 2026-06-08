import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/transbank/movements — lista TbkTesoreria (POS ventas TBK, rubro 17).
 * Filtros: ?sucursalId ?since ?until ?q ?limit ?offset
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const sucursalId = url.searchParams.get("sucursalId");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const q = url.searchParams.get("q");
  const limit = clampInt(url.searchParams.get("limit"), 1, 5000, 500);
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

  const where: Prisma.TbkTesoreriaWhereInput = {};
  if (sucursalId) {
    const n = parseInt(sucursalId, 10);
    if (!Number.isNaN(n)) where.sucursalId = n;
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
      { opNumber: { contains: q } },
    ];
  }

  const [rows, total, sucursales, agg] = await Promise.all([
    prisma.tbkTesoreria.findMany({ where, orderBy: { fecha: "desc" }, take: limit, skip: offset }),
    prisma.tbkTesoreria.count({ where }),
    prisma.tbkTesoreria.groupBy({ by: ["sucursalId", "sucursalName"], orderBy: [{ sucursalId: "asc" }] }),
    prisma.tbkTesoreria.aggregate({ where, _sum: { monto: true } }),
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
      opNumber: m.opNumber,
      sucursalId: m.sucursalId,
      sucursalName: m.sucursalName,
      cajeroUsername: m.cajeroUsername,
      cajeroName: m.cajeroName,
      folio: m.folio.toString(),
      clienteName: m.clienteName,
      clienteRut: m.clienteRut,
      fechaCarga: m.fechaCarga?.toISOString() ?? null,
    })),
    facets: {
      sucursales: sucursales.map((s) => ({ id: s.sucursalId, name: s.sucursalName })),
    },
  });
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
