import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/transbank/sales — lista TransbankSale (settlement "Abonos por día"
 * importado). Para verlo en Cartolas sin ir a Consolidados.
 * Filtros: ?since ?until ?sucursalId ?q ?limit ?offset
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const sucursalId = url.searchParams.get("sucursalId");
  const q = url.searchParams.get("q");
  const limit = clampInt(url.searchParams.get("limit"), 1, 5000, 500);
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0);

  const where: Prisma.TransbankSaleWhereInput = {};
  if (sucursalId) {
    const n = parseInt(sucursalId, 10);
    if (!Number.isNaN(n)) where.sucursalId = n;
  }
  if (since || until) {
    where.fechaVenta = {};
    if (since) (where.fechaVenta as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.fechaVenta as Prisma.DateTimeFilter).lt = end;
    }
  }
  if (q && q.trim() !== "") {
    where.OR = [
      { nombreLocal: { contains: q, mode: "insensitive" } },
      { medioPago: { contains: q, mode: "insensitive" } },
      { numeroBoleta: { contains: q } },
      { tid: { contains: q } },
    ];
  }

  const soloSinConciliar = url.searchParams.get("soloSinConciliar") === "true";

  // Cargamos TODO el rango (son pocos) para poder marcar conciliación contra el
  // POS y filtrar/paginar en memoria.
  const [allRows, sucursales, posRows] = await Promise.all([
    prisma.transbankSale.findMany({ where, orderBy: { fechaVenta: "desc" } }),
    prisma.transbankSale.groupBy({ by: ["sucursalId"], orderBy: [{ sucursalId: "asc" }] }),
    prisma.tbkTesoreria.findMany({ select: { opNumber: true, monto: true } }),
  ]);

  // Conciliación: un abono está cuadrado si hay un POS con la misma boleta(=OP)
  // y monto dentro de la tolerancia (recargo de crédito ~2%). Misma llave que
  // el motor de Cruce Transbank.
  const absB = (n: bigint) => (n < 0n ? -n : n);
  const posByOp = new Map<string, bigint[]>();
  for (const p of posRows) {
    if (!p.opNumber) continue;
    (posByOp.get(p.opNumber) ?? posByOp.set(p.opNumber, []).get(p.opNumber)!).push(p.monto);
  }
  const isConciliado = (s: { numeroBoleta: string | null; montoVenta: bigint }) => {
    if (!s.numeroBoleta) return false;
    const base = Number(absB(s.montoVenta));
    return (posByOp.get(s.numeroBoleta) ?? []).some(
      (m) => base > 0 && Number(absB(m - s.montoVenta)) / base <= 0.05,
    );
  };

  const withC = allRows.map((s) => ({ s, conc: isConciliado(s) }));
  const conciliados = withC.filter((x) => x.conc).length;
  const sinConciliar = withC.length - conciliados;
  const filtered = soloSinConciliar ? withC.filter((x) => !x.conc) : withC;
  const total = filtered.length;
  const pageItems = filtered.slice(offset, offset + limit);

  let sumBruto = 0n, sumCom = 0n, sumNeto = 0n;
  for (const x of filtered) {
    sumBruto += x.s.montoVenta;
    sumCom += x.s.comision + x.s.ivaComision;
    sumNeto += x.s.totalAbono;
  }

  // Nombres de sucursal desde el catálogo de TbkTesoreria (las settlement no
  // siempre traen sucursalId resuelto).
  // Nombres de sucursal: del POS (TbkTesoreria) y del feed Tesorería
  // (TesoreriaMovement), que SÍ tiene Bosque/Suecia y demás. Así los abonos
  // de sucursales sin POS muestran su nombre en vez de "#2"/"#3".
  const sucMap = new Map<number, string | null>();
  const [tbkSuc, tesoSuc] = await Promise.all([
    prisma.tbkTesoreria.groupBy({ by: ["sucursalId", "sucursalName"] }),
    prisma.tesoreriaMovement.groupBy({ by: ["sucursalId", "sucursalName"] }),
  ]);
  for (const s of tesoSuc) if (s.sucursalName) sucMap.set(s.sucursalId, s.sucursalName);
  for (const s of tbkSuc) if (s.sucursalName) sucMap.set(s.sucursalId, s.sucursalName);

  return NextResponse.json({
    total,
    limit,
    offset,
    conciliados,
    sinConciliar,
    sums: {
      bruto: sumBruto.toString(),
      comision: sumCom.toString(),
      neto: sumNeto.toString(),
    },
    sales: pageItems.map(({ s, conc }) => ({
      id: s.id,
      fechaVenta: s.fechaVenta.toISOString(),
      nombreLocal: s.nombreLocal,
      sucursalId: s.sucursalId,
      medioPago: s.medioPago,
      montoVenta: s.montoVenta.toString(),
      comision: (s.comision + s.ivaComision).toString(),
      totalAbono: s.totalAbono.toString(),
      numeroBoleta: s.numeroBoleta,
      tid: s.tid,
      conciliado: conc,
    })),
    facets: {
      sucursales: sucursales
        .filter((s): s is { sucursalId: number } => s.sucursalId !== null)
        .map((s) => ({ id: s.sucursalId, name: sucMap.get(s.sucursalId) ?? null })),
    },
  });
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
