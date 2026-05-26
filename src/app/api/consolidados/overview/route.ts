import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/consolidados/overview?period=day|week|month
 *
 * Resumen del módulo Consolidados:
 *  - counts: cantidad de TesoreriaMovements por estado del Consolidado
 *  - rows: lista cronológica descendente con detalle ligero
 *
 * Filtros:
 *  ?status=<csv>     filtrar por estados específicos
 *  ?accountId=<uuid> filtrar por cuenta bancaria resuelta
 *  ?banco=<string>   filtrar por banco asignado en Tesoreria (substring)
 *  ?q=<texto>        búsqueda libre en cliente/glosa
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const period = (url.searchParams.get("period") || "month") as "day" | "week" | "month";
  const statusCsv = url.searchParams.get("status");
  const statusFilter = statusCsv
    ? statusCsv.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const accountId = url.searchParams.get("accountId");
  const banco = (url.searchParams.get("banco") || "").trim();
  const search = (url.searchParams.get("q") || "").trim();

  const range = getPeriodRange(period);

  // Counts globales (no filtrados por status) para que los chips muestren totales
  const countsRaw = await prisma.consolidado.groupBy({
    by: ["status"],
    where: {
      tesoreriaMovement: {
        fecha: { gte: range.start, lt: range.end },
        ...(banco ? { banco: { contains: banco, mode: "insensitive" as const } } : {}),
      },
    },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    AUTO_MATCHED: 0,
    MANUAL: 0,
    SUGGESTED: 0,
    REVIEW: 0,
    NO_MATCH: 0,
    OUT_OF_SCOPE: 0,
    UNPROCESSED: 0,
  };
  for (const c of countsRaw) counts[c.status] = c._count._all;

  // Tesoreria sin Consolidado (no procesado) — también lo contamos
  const unprocessed = await prisma.tesoreriaMovement.count({
    where: {
      fecha: { gte: range.start, lt: range.end },
      consolidado: null,
      ...(banco ? { banco: { contains: banco, mode: "insensitive" as const } } : {}),
    },
  });
  counts.UNPROCESSED = unprocessed;

  // Rows: TesoreriaMovements con su Consolidado + link
  const tesorerias = await prisma.tesoreriaMovement.findMany({
    where: {
      fecha: { gte: range.start, lt: range.end },
      ...(banco ? { banco: { contains: banco, mode: "insensitive" as const } } : {}),
      ...(statusFilter
        ? statusFilter.includes("UNPROCESSED")
          ? statusFilter.length === 1
            ? { consolidado: null }
            : {
                OR: [
                  { consolidado: null },
                  {
                    consolidado: {
                      status: { in: statusFilter.filter((s) => s !== "UNPROCESSED") },
                    },
                  },
                ],
              }
          : { consolidado: { status: { in: statusFilter } } }
        : {}),
      ...(accountId
        ? { consolidado: { resolvedAccountId: accountId } }
        : {}),
      ...(search
        ? {
            OR: [
              { glosa: { contains: search, mode: "insensitive" as const } },
              { clienteName: { contains: search, mode: "insensitive" as const } },
              { clienteRut: { contains: search, mode: "insensitive" as const } },
              { sucursalName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: {
      consolidado: {
        include: {
          links: {
            include: {
              bankMovement: {
                include: {
                  account: {
                    select: {
                      id: true,
                      bankCode: true,
                      bankName: true,
                      accountNumber: true,
                      displayNumber: true,
                      holderName: true,
                      alias: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { fecha: "desc" },
    take: 500,
  });

  const rows = tesorerias.map((t) => ({
    id: t.id,
    externalId: t.externalId.toString(),
    fecha: t.fecha.toISOString(),
    monto: t.monto.toString(),
    sucursalId: t.sucursalId,
    sucursalName: t.sucursalName,
    banco: t.banco,
    bancoSucursal: t.bancoSucursal,
    bancoDetectado: t.bancoDetectado,
    esExcepcion: t.esExcepcion,
    glosa: t.glosa,
    folio: t.folio.toString(),
    clienteName: t.clienteName,
    clienteRut: t.clienteRut,
    rubroSucursal: t.rubroSucursal,
    rubroBanco: t.rubroBanco,
    consolidado: t.consolidado
      ? {
          id: t.consolidado.id,
          status: t.consolidado.status,
          matchType: t.consolidado.matchType,
          score: t.consolidado.score,
          notes: t.consolidado.notes,
          resolvedAccountId: t.consolidado.resolvedAccountId,
          links: t.consolidado.links.map((l) => ({
            bankMovementId: l.bankMovementId,
            postDate: l.bankMovement.postDate.toISOString(),
            amount: l.bankMovement.amount.toString(),
            description: l.bankMovement.description,
            counterpartyName: l.bankMovement.counterpartyName,
            counterpartyRut: l.bankMovement.counterpartyRut,
            account: l.bankMovement.account,
          })),
        }
      : null,
  }));

  // Facets para filtros (bancos disponibles en el período)
  const bancosRaw = await prisma.tesoreriaMovement.findMany({
    where: { fecha: { gte: range.start, lt: range.end }, banco: { not: null } },
    select: { banco: true },
    distinct: ["banco"],
  });
  const bancos = bancosRaw
    .map((b) => b.banco)
    .filter((b): b is string => !!b)
    .sort();

  return NextResponse.json({
    period,
    counts,
    rows,
    facets: { bancos },
  });
}

function getPeriodRange(period: "day" | "week" | "month"): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  if (period === "day") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    start.setDate(start.getDate() - 7);
    start.setHours(0, 0, 0, 0);
  } else {
    // month
    start.setDate(start.getDate() - 30);
    start.setHours(0, 0, 0, 0);
  }
  return { start, end };
}
