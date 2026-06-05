import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/tesoreria/movements
 *
 * Filtros opcionales:
 *   ?sucursalId=<int>
 *   ?cajero=<username>
 *   ?banco=<texto>
 *   ?bancoDetectado=<texto>
 *   ?rubroBanco=<int|none>
 *   ?rubroSucursal=<int|none>
 *   ?excepcion=1|0
 *   ?since=YYYY-MM-DD
 *   ?until=YYYY-MM-DD
 *   ?q=<texto libre>
 *   ?limit, ?offset
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sucursalId = url.searchParams.get("sucursalId");
  const cajero = url.searchParams.get("cajero");
  const banco = url.searchParams.get("banco");
  const bancoDetectado = url.searchParams.get("bancoDetectado");
  const rubroBancoRaw = url.searchParams.get("rubroBanco");
  const rubroSucursalRaw = url.searchParams.get("rubroSucursal");
  const excepcionRaw = url.searchParams.get("excepcion");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const search = url.searchParams.get("q");
  const limit = clampInt(url.searchParams.get("limit"), 1, 5000, 500);
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

  const where: Prisma.TesoreriaMovementWhereInput = {};

  if (sucursalId) {
    const n = parseInt(sucursalId, 10);
    if (!Number.isNaN(n)) where.sucursalId = n;
  }
  if (cajero) where.cajeroUsername = cajero.toUpperCase();
  if (banco) where.banco = banco;
  if (bancoDetectado) {
    if (bancoDetectado === "none") where.bancoDetectado = null;
    else where.bancoDetectado = bancoDetectado;
  }
  if (rubroBancoRaw) {
    if (rubroBancoRaw === "none") where.rubroBanco = null;
    else {
      const n = parseInt(rubroBancoRaw, 10);
      if (!Number.isNaN(n)) where.rubroBanco = n;
    }
  }
  if (rubroSucursalRaw) {
    if (rubroSucursalRaw === "none") where.rubroSucursal = null;
    else {
      const n = parseInt(rubroSucursalRaw, 10);
      if (!Number.isNaN(n)) where.rubroSucursal = n;
    }
  }
  if (excepcionRaw === "1") where.esExcepcion = true;
  else if (excepcionRaw === "0") where.esExcepcion = false;

  if (since || until) {
    where.fecha = {};
    if (since) (where.fecha as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.fecha as Prisma.DateTimeFilter).lt = end;
    }
  }

  if (search && search.trim() !== "") {
    where.OR = [
      { glosa: { contains: search, mode: "insensitive" } },
      { sucursalName: { contains: search, mode: "insensitive" } },
      { cajeroUsername: { contains: search, mode: "insensitive" } },
      { cajeroName: { contains: search, mode: "insensitive" } },
      { banco: { contains: search, mode: "insensitive" } },
      { bancoDetectado: { contains: search, mode: "insensitive" } },
      { clienteName: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total, sucursales, cajeros, bancos, rubrosBanco, rubrosSucursal, rubroLabels] =
    await Promise.all([
      prisma.tesoreriaMovement.findMany({
        where,
        orderBy: [{ fecha: "desc" }],
        take: limit,
        skip: offset,
      }),
      prisma.tesoreriaMovement.count({ where }),
      prisma.tesoreriaMovement.groupBy({
        by: ["sucursalId", "sucursalName"],
        orderBy: [{ sucursalId: "asc" }],
      }),
      prisma.tesoreriaMovement.groupBy({
        by: ["cajeroUsername"],
        orderBy: [{ cajeroUsername: "asc" }],
      }),
      prisma.tesoreriaMovement.groupBy({
        by: ["banco"],
        _count: { _all: true },
        orderBy: [{ banco: "asc" }],
      }),
      prisma.tesoreriaMovement.groupBy({
        by: ["rubroBanco"],
        _count: { _all: true },
        orderBy: [{ rubroBanco: "asc" }],
      }),
      prisma.tesoreriaMovement.groupBy({
        by: ["rubroSucursal"],
        _count: { _all: true },
        orderBy: [{ rubroSucursal: "asc" }],
      }),
      prisma.rubroLabel.findMany({ select: { rubro: true, name: true } }),
    ]);

  const labelByRubro = new Map(rubroLabels.map((l) => [l.rubro, l.name]));

  return NextResponse.json({
    total,
    limit,
    offset,
    movements: rows.map(serialize),
    facets: {
      sucursales: sucursales.map((s) => ({
        id: s.sucursalId,
        name: s.sucursalName,
      })),
      cajeros: cajeros.map((c) => c.cajeroUsername),
      bancos: bancos
        .filter((b) => b.banco !== null)
        .map((b) => ({ name: b.banco as string, count: b._count._all })),
      rubrosBanco: rubrosBanco.map((r) => ({
        rubro: r.rubroBanco,
        name: r.rubroBanco !== null ? labelByRubro.get(r.rubroBanco) ?? null : null,
        count: r._count._all,
      })),
      rubrosSucursal: rubrosSucursal.map((r) => ({
        rubro: r.rubroSucursal,
        name: r.rubroSucursal !== null ? labelByRubro.get(r.rubroSucursal) ?? null : null,
        count: r._count._all,
      })),
    },
  });
}

function serialize(m: Awaited<ReturnType<typeof prisma.tesoreriaMovement.findFirst>>) {
  if (!m) return null;
  return {
    id: m.id,
    externalId: m.externalId.toString(),
    sucursalId: m.sucursalId,
    sucursalName: m.sucursalName,
    cajeroUsername: m.cajeroUsername,
    cajeroName: m.cajeroName,
    clienteName: m.clienteName,
    clienteRut: m.clienteRut,
    folio: m.folio.toString(),
    tipoDocumento: m.tipoDocumento,
    codigoDocumento: m.codigoDocumento,
    glosa: m.glosa,
    banco: m.banco,
    bancoSucursal: m.bancoSucursal,
    bancoDetectado: m.bancoDetectado,
    rubroBanco: m.rubroBanco,
    rubroSucursal: m.rubroSucursal,
    monto: m.monto.toString(),
    tipoOperacion: m.tipoOperacion,
    fecha: m.fecha.toISOString(),
    fechaCarga: m.fechaCarga?.toISOString() ?? null,
    esExcepcion: m.esExcepcion,
    items: m.items,
    syncedAt: m.syncedAt.toISOString(),
  };
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
