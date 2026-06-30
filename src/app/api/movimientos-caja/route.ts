import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/movimientos-caja
 * Lista los movimientos de caja (depositos/retiros/traspasos) con su estado de
 * conciliacion contra la cartola, + resumen agregado.
 * Filtros: ?status=&categoria=&banco=&limit=&offset=
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const where: Record<string, unknown> = {};
  if (sp.get("status")) where.status = sp.get("status");
  if (sp.get("categoria")) where.categoria = sp.get("categoria");
  if (sp.get("banco")) where.banco = sp.get("banco");
  const limit = Math.min(Number(sp.get("limit") || 200), 1000);
  const offset = Number(sp.get("offset") || 0);

  const [total, rows, byStatus] = await Promise.all([
    prisma.movimientoCaja.count({ where }),
    prisma.movimientoCaja.findMany({
      where,
      orderBy: { fecha: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.movimientoCaja.groupBy({ by: ["status"], _count: { _all: true }, _sum: { monto: true } }),
  ]);

  const resumen = byStatus.map((g: { status: string; _count: { _all: number }; _sum: { monto: bigint | null } }) => ({
    status: g.status,
    movimientos: g._count._all,
    monto: (g._sum.monto ?? 0n).toString(),
  }));

  const data = rows.map((r: Record<string, unknown>) => ({
    ...r,
    externalId: String(r.externalId),
    mcjId: String(r.mcjId),
    monto: String(r.monto),
  }));

  return NextResponse.json({ total, resumen, data });
}
