import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/dashboard/sin-cliente
 *
 * Auditoría: movimientos de Tesorería SIN cliente (clienteName vacío) en el
 * período, para revisar qué sucursal/cajero los registró. Excluye anulados.
 *
 * Filtros: ?from&to (ISO), ?sucursalId=<int>, ?cajero=<cajeroUsername>.
 * Devuelve la lista (limitada) + totales del filtro completo.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const sucursalIdRaw = url.searchParams.get("sucursalId");
  const cajero = url.searchParams.get("cajero");

  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;

  const where: Prisma.TesoreriaMovementWhereInput = {
    // "sin cliente": null o vacío. (Prisma no matchea whitespace-only; el trim
    // real lo cubre el cómputo del dashboard; acá cubrimos null y "".)
    OR: [{ clienteName: null }, { clienteName: "" }],
    NOT: { estadoActual: "ANU" },
    // Excluye ventas con tarjeta (TBK): no traen cliente y se cuadran aparte.
    claseOperacion: { not: "TBK" },
  };
  if (from || to) {
    where.fecha = {};
    if (from) (where.fecha as Prisma.DateTimeFilter).gte = from;
    if (to) (where.fecha as Prisma.DateTimeFilter).lt = to;
  }
  if (sucursalIdRaw && /^\d+$/.test(sucursalIdRaw)) {
    where.sucursalId = parseInt(sucursalIdRaw, 10);
  }
  if (cajero) where.cajeroUsername = cajero;

  const [rows, agg] = await Promise.all([
    prisma.tesoreriaMovement.findMany({
      where,
      orderBy: { fecha: "desc" },
      take: 500,
      select: {
        id: true,
        fecha: true,
        sucursalId: true,
        sucursalName: true,
        cajeroUsername: true,
        cajeroName: true,
        monto: true,
        glosa: true,
        tipoOperacion: true,
      },
    }),
    prisma.tesoreriaMovement.aggregate({
      where,
      _count: { _all: true },
      _sum: { monto: true },
    }),
  ]);

  return NextResponse.json({
    total: agg._count._all,
    montoTotal: (agg._sum.monto ?? 0n).toString(),
    truncated: agg._count._all > rows.length,
    movements: rows.map((m) => ({
      id: m.id,
      fecha: m.fecha.toISOString(),
      sucursalId: m.sucursalId,
      sucursalName: m.sucursalName,
      cajeroUsername: m.cajeroUsername,
      cajeroName: m.cajeroName,
      monto: m.monto.toString(),
      glosa: m.glosa,
      tipoOperacion: m.tipoOperacion,
    })),
  });
}
