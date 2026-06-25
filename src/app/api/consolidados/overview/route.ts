import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { excluirFueraAlcanceWhere } from "@/lib/consolidados/scope";

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
  const tipoOperacionRaw = (url.searchParams.get("tipoOperacion") || "").trim();
  const tipoOperacion =
    tipoOperacionRaw === "INGRESO" || tipoOperacionRaw === "EGRESO" ? tipoOperacionRaw : null;
  const sucursalIdRaw = url.searchParams.get("sucursalId");
  const sucursalId =
    sucursalIdRaw && /^\d+$/.test(sucursalIdRaw) ? parseInt(sucursalIdRaw, 10) : null;

  const range = getPeriodRange(period);

  // Alcance base compartido por los chips (counts) y las filas: período, banco,
  // tipo (ingreso/egreso), sucursal y exclusión de TBK (se cuadra en Cruce
  // Transbank). NO incluye status ni búsqueda — esos son propios del listado.
  const baseScope = {
    fecha: { gte: range.start, lt: range.end },
    claseOperacion: { not: "TBK" as const },
    // Fuera de alcance (COMPRA CUENTA APP MORE GIROS): excluidos de counts y filas.
    ...excluirFueraAlcanceWhere,
    ...(banco ? { banco: { contains: banco, mode: "insensitive" as const } } : {}),
    ...(tipoOperacion ? { tipoOperacion } : {}),
    ...(sucursalId !== null ? { sucursalId } : {}),
  };

  // Counts globales (no filtrados por status) para que los chips muestren totales
  const countsRaw = await prisma.consolidado.groupBy({
    by: ["status"],
    where: { tesoreriaMovement: baseScope },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    AUTO_MATCHED: 0,
    MANUAL: 0,
    SUGGESTED: 0,
    REVIEW: 0,
    NO_MATCH: 0,
    OUT_OF_SCOPE: 0,
    ANULADO: 0,
    UNPROCESSED: 0,
  };
  for (const c of countsRaw) counts[c.status] = c._count._all;

  // Tesoreria sin Consolidado (no procesado) — también lo contamos. Los
  // anulados no cuentan como pendiente aunque aún no tengan Consolidado.
  const unprocessed = await prisma.tesoreriaMovement.count({
    where: { ...baseScope, consolidado: null, estadoActual: { not: "ANU" as const } },
  });
  counts.UNPROCESSED = unprocessed;

  // Filtro completo del listado: alcance base + status + cuenta + búsqueda.
  const rowsWhere = {
    ...baseScope,
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
    ...(accountId ? { consolidado: { resolvedAccountId: accountId } } : {}),
    ...(search
      ? {
          OR: [
            { glosa: { contains: search, mode: "insensitive" as const } },
            { clienteName: { contains: search, mode: "insensitive" as const } },
            { clienteRut: { contains: search, mode: "insensitive" as const } },
            { sucursalName: { contains: search, mode: "insensitive" as const } },
            // Si el termino es numerico (con o sin separadores de miles),
            // matcheamos por PREFIJO de monto. "700000" matchea cualquier
            // monto cuya representacion decimal empieza con 700000 — esto
            // incluye 700000, 7000000, 70000000, etc. Se arma con rangos
            // [X·10^k, (X+1)·10^k) para que Prisma lo resuelva en SQL.
            ...searchAmountRanges(search).map((r) => ({ monto: r })),
          ],
        }
      : {}),
  };

  // Rows + total + suma monetaria del filtro actual. El total/suma se calculan
  // sobre TODO el filtro (no solo las 500 filas que se listan), para el footer
  // "X de Y" y el resumen "N movs · suma $X".
  const [tesorerias, filteredTotal, sumAgg] = await Promise.all([
    prisma.tesoreriaMovement.findMany({
    where: rowsWhere,
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
    }),
    prisma.tesoreriaMovement.count({ where: rowsWhere }),
    prisma.tesoreriaMovement.aggregate({ _sum: { monto: true }, where: rowsWhere }),
  ]);
  const filteredSum = (sumAgg._sum.monto ?? 0n).toString();

  const rows = tesorerias.map((t) => ({
    id: t.id,
    externalId: t.externalId.toString(),
    fecha: t.fecha.toISOString(),
    monto: t.monto.toString(),
    tipoOperacion: t.tipoOperacion,
    sucursalId: t.sucursalId,
    sucursalName: t.sucursalName,
    banco: t.banco,
    bancoSucursal: t.bancoSucursal,
    bancoDetectado: t.bancoDetectado,
    esExcepcion: t.esExcepcion,
    estadoActual: t.estadoActual,
    anulado: t.anulado,
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

  // Sucursales del período (para el dropdown). Independiente de los filtros
  // activos, así siempre se puede cambiar de sucursal.
  const periodScope = {
    fecha: { gte: range.start, lt: range.end },
    claseOperacion: { not: "TBK" as const },
    ...excluirFueraAlcanceWhere,
  };
  const sucursalesRaw = await prisma.tesoreriaMovement.groupBy({
    by: ["sucursalId", "sucursalName"],
    where: periodScope,
    orderBy: { sucursalId: "asc" },
  });
  const sucursales = sucursalesRaw.map((s) => ({ id: s.sucursalId, name: s.sucursalName }));

  return NextResponse.json({
    period,
    counts,
    rows,
    filteredTotal,
    filteredSum,
    facets: { bancos, sucursales },
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

/**
 * Convierte un termino de busqueda numerico en una lista de rangos para
 * matchear por PREFIJO de monto. Para "700000" devuelve los rangos:
 *   [700000, 700001), [7000000, 7100000), [70000000, 71000000), ...
 * hasta cubrir hasta 10^13 (un billon de CLP, mas que suficiente).
 *
 * Si el termino tiene letras u otros chars no-numericos, retorna []
 * (= "no aplica filtro por monto").
 */
function searchAmountRanges(s: string): { gte: bigint; lt: bigint }[] {
  const cleaned = s.replace(/[.,\s$]/g, "");
  if (cleaned.length === 0 || !/^\d+$/.test(cleaned)) return [];

  const base = BigInt(cleaned);
  const next = base + 1n;
  const ranges: { gte: bigint; lt: bigint }[] = [];
  const MAX_DIGITS = 13;
  for (let extra = 0; cleaned.length + extra <= MAX_DIGITS; extra++) {
    const mul = 10n ** BigInt(extra);
    ranges.push({ gte: base * mul, lt: next * mul });
  }
  return ranges;
}
