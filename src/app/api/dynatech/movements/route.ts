import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/cartolas/normalize";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/dynatech/movements
 *
 * Filtros opcionales (todos manuales del usuario, ninguno obligatorio):
 *   ?branchId=<int>         filtrar por sucursal externa
 *   ?cashier=<username>     filtrar por cajero
 *   ?docCode=<int>          filtrar por código de documento (34, 41, etc.)
 *   ?direction=IN|OUT       ingreso (Venta de…) / egreso (Compra de…)
 *   ?since=YYYY-MM-DD       desde fecha
 *   ?until=YYYY-MM-DD       hasta fecha
 *   ?minAmount, ?maxAmount  rango de monto
 *   ?customerRut=<rut>      filtrar por RUT cliente (normalizado)
 *   ?rubro=<int|none>       filtrar por rubro contable Dynatech ("none" = sin rubro)
 *   ?q=<texto>              búsqueda libre (observación, sucursal, cajero, cliente)
 *   ?limit, ?offset         paginación interna (default 200, máx 5000)
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const branchId = url.searchParams.get("branchId");
  const cashier = url.searchParams.get("cashier");
  const docCode = url.searchParams.get("docCode");
  const direction = url.searchParams.get("direction");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const minAmount = url.searchParams.get("minAmount");
  const maxAmount = url.searchParams.get("maxAmount");
  const search = url.searchParams.get("q");
  const customerRutRaw = url.searchParams.get("customerRut");
  const rubroRaw = url.searchParams.get("rubro");
  const limit = clampInt(url.searchParams.get("limit"), 1, 5000, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

  const where: Prisma.DynatechMovementWhereInput = {};
  const customerRut = customerRutRaw ? normalizeRut(customerRutRaw) : null;
  if (customerRut) where.customerRut = customerRut;
  if (branchId) {
    const n = parseInt(branchId, 10);
    if (!Number.isNaN(n)) where.branchExternalId = n;
  }
  if (cashier) where.cashierUsername = cashier.toUpperCase();
  if (docCode) {
    const n = parseInt(docCode, 10);
    if (!Number.isNaN(n)) where.documentCode = n;
  }
  if (rubroRaw) {
    if (rubroRaw === "none") {
      where.rubro = null;
    } else {
      const n = parseInt(rubroRaw, 10);
      if (!Number.isNaN(n)) where.rubro = n;
    }
  }

  if (since || until) {
    where.occurredAt = {};
    if (since) (where.occurredAt as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.occurredAt as Prisma.DateTimeFilter).lt = end;
    }
  }

  if (minAmount || maxAmount) {
    where.totalAmount = {};
    if (minAmount) (where.totalAmount as Prisma.BigIntFilter).gte = BigInt(minAmount);
    if (maxAmount) (where.totalAmount as Prisma.BigIntFilter).lte = BigInt(maxAmount);
  }

  // Filtro por dirección (ingreso/egreso) — derivado del primer item:
  //   "Venta de …"  → INGRESO (entra CLP a la cuenta)
  //   "Compra de …" → EGRESO (sale CLP de la cuenta)
  // Implementado con search sobre items.0.nombre serializado en JSON.
  if (direction === "IN" || direction === "OUT") {
    const needle = direction === "IN" ? "Venta de" : "Compra de";
    // Filtramos sobre rawJson.items[0].nombre — no es perfecto pero cubre la mayoría
    where.items = { path: ["0", "nombre"], string_contains: needle } as Prisma.JsonFilter;
  }

  if (search && search.trim() !== "") {
    where.OR = [
      { observation: { contains: search, mode: "insensitive" } },
      { branchExternalName: { contains: search, mode: "insensitive" } },
      { cashierUsername: { contains: search, mode: "insensitive" } },
      { customerName: { contains: search, mode: "insensitive" } },
      { customerRut: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total, branches, cashiers, rubros, rubroLabels] = await Promise.all([
    prisma.dynatechMovement.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.dynatechMovement.count({ where }),
    // Distintos para selectores (sin filtro)
    prisma.dynatechMovement.groupBy({
      by: ["branchExternalId", "branchExternalName"],
      orderBy: [{ branchExternalId: "asc" }],
    }),
    prisma.dynatechMovement.groupBy({
      by: ["cashierUsername"],
      orderBy: [{ cashierUsername: "asc" }],
    }),
    prisma.dynatechMovement.groupBy({
      by: ["rubro"],
      _count: { _all: true },
      orderBy: [{ rubro: "asc" }],
    }),
    prisma.rubroLabel.findMany({
      select: { rubro: true, name: true },
    }),
  ]);

  const labelByRubro = new Map(rubroLabels.map((l) => [l.rubro, l.name]));

  return NextResponse.json({
    total,
    limit,
    offset,
    movements: rows.map(serialize),
    facets: {
      branches: branches.map((b) => ({
        id: b.branchExternalId,
        name: b.branchExternalName,
      })),
      cashiers: cashiers.map((c) => c.cashierUsername),
      rubros: rubros.map((r) => ({
        rubro: r.rubro,
        name: r.rubro !== null ? labelByRubro.get(r.rubro) ?? null : null,
        count: r._count._all,
      })),
    },
  });
}

function serialize(m: Awaited<ReturnType<typeof prisma.dynatechMovement.findFirst>>) {
  if (!m) return null;
  return {
    id: m.id,
    mCjId: m.mCjId.toString(),
    branchExternalId: m.branchExternalId,
    branchExternalName: m.branchExternalName,
    cashierUsername: m.cashierUsername,
    cashierName: m.cashierName,
    customerName: m.customerName,
    customerRut: m.customerRut,
    documentCode: m.documentCode,
    documentType: m.documentType,
    documentFolio: m.documentFolio.toString(),
    observation: m.observation,
    occurredAt: m.occurredAt.toISOString(),
    loadedAt: m.loadedAt?.toISOString() ?? null,
    totalAmount: m.totalAmount.toString(),
    currency: m.currency,
    rubro: m.rubro,
    items: m.items,
    syncedAt: m.syncedAt.toISOString(),
  };
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  def: number
): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
