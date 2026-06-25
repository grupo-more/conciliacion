import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { matchCruce } from "@/lib/transbank/cruce";

/**
 * GET /api/consolidados/cruce-transbank?from=YYYY-MM-DD&to=YYYY-MM-DD&sucursalId=&estado=
 *
 * Cruza el POS (TbkTesoreria, /api/tbk-tesoreria) contra el settlement de
 * Transbank (TransbankSale, archivo "Abonos por dia").
 *
 * Llave: opNumber (POS) == numeroBoleta (settlement) + monto bruto. Fallback:
 * monto bruto + fecha (±1d). Vista derivada (no persiste). 1:1.
 *
 * estado = cuadrado | pos_sin_settlement | settlement_sin_pos (filtro opcional).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const sucursalIdRaw = url.searchParams.get("sucursalId");
  const sucursalId = sucursalIdRaw ? parseInt(sucursalIdRaw, 10) : null;
  const estado = url.searchParams.get("estado");

  const [posAll, settAll, manualLinks] = await Promise.all([
    prisma.tbkTesoreria.findMany({
      // Ventas POS anuladas en origen quedan fuera del cruce.
      where: { fecha: { gte: from, lt: to }, estadoActual: { not: "ANU" } },
      orderBy: { fecha: "desc" },
    }),
    prisma.transbankSale.findMany({
      where: { fechaVenta: { gte: from, lt: to } },
      orderBy: { fechaVenta: "desc" },
    }),
    prisma.cruceTransbankLink.findMany({
      select: { tbkTesoreriaId: true, transbankSaleId: true },
    }),
  ]);
  const manualPosIds = new Set(manualLinks.map((l) => l.tbkTesoreriaId));

  // Nombres de sucursal: POS + feed Tesorería (que tiene Bosque/Suecia, etc.),
  // para que los abonos "sin POS" muestren el nombre y no "#2"/"#3".
  const sucName = new Map<number, string | null>();
  const tesoSuc = await prisma.tesoreriaMovement.groupBy({ by: ["sucursalId", "sucursalName"] });
  for (const s of tesoSuc) if (s.sucursalName) sucName.set(s.sucursalId, s.sucursalName);
  for (const p of posAll) if (p.sucursalName) sucName.set(p.sucursalId, p.sucursalName);

  const absB = (n: bigint) => (n < 0n ? -n : n);

  // Matching POS ↔ settlement (lib compartida con la cuadratura/asiento).
  // Los vínculos manuales se fuerzan como cuadrados.
  const { pairs, settlementOnly } = matchCruce(posAll, settAll, manualLinks);

  // Serializar filas según estado.
  type Row = {
    estado: "cuadrado" | "pos_sin_settlement" | "settlement_sin_pos";
    fecha: string;
    sucursalId: number | null;
    sucursalName: string | null;
    op: string | null;
    glosa: string | null;
    medioPago: string | null;
    montoBruto: string;
    comision: string | null;
    neto: string | null;
    diferencia: string | null;     // settlement bruto - POS base (recargo crédito)
    diferenciaPct: number | null;
    tid: string | null;
    boleta: string | null;
    tbkTesoreriaId: string | null;
    transbankSaleId: string | null;
    manual: boolean;
    ficticio: boolean; // POS insertado a mano (TbkTesoreria.manual)
  };
  const rows: Row[] = [];

  for (const p of pairs) {
    if (p.sett) {
      const base = Number(absB(p.pos.monto));
      rows.push({
        estado: "cuadrado",
        fecha: p.pos.fecha.toISOString(),
        sucursalId: p.pos.sucursalId,
        sucursalName: p.pos.sucursalName,
        op: p.pos.opNumber,
        glosa: p.pos.glosa,
        medioPago: p.sett.medioPago,
        montoBruto: p.pos.monto.toString(),
        comision: (p.sett.comision + p.sett.ivaComision).toString(),
        neto: p.sett.totalAbono.toString(),
        diferencia: p.diff.toString(),
        diferenciaPct: base > 0 ? Math.round((Number(p.diff) / base) * 1000) / 10 : null,
        tid: p.sett.tid,
        boleta: p.sett.numeroBoleta,
        tbkTesoreriaId: p.pos.id,
        transbankSaleId: p.sett.id,
        manual: manualPosIds.has(p.pos.id),
        ficticio: p.pos.manual,
      });
    } else {
      rows.push({
        estado: "pos_sin_settlement",
        fecha: p.pos.fecha.toISOString(),
        sucursalId: p.pos.sucursalId,
        sucursalName: p.pos.sucursalName,
        op: p.pos.opNumber,
        glosa: p.pos.glosa,
        medioPago: null,
        montoBruto: p.pos.monto.toString(),
        comision: null,
        neto: null,
        diferencia: null,
        diferenciaPct: null,
        tid: null,
        boleta: null,
        tbkTesoreriaId: p.pos.id,
        transbankSaleId: null,
        manual: false,
        ficticio: p.pos.manual,
      });
    }
  }
  for (const s of settlementOnly) {
    rows.push({
      estado: "settlement_sin_pos",
      fecha: s.fechaVenta.toISOString(),
      sucursalId: s.sucursalId,
      sucursalName: s.sucursalId != null ? sucName.get(s.sucursalId) ?? null : null,
      op: null,
      glosa: s.nombreLocal,
      medioPago: s.medioPago,
      montoBruto: s.montoVenta.toString(),
      comision: (s.comision + s.ivaComision).toString(),
      neto: s.totalAbono.toString(),
      diferencia: null,
      diferenciaPct: null,
      tid: s.tid,
      boleta: s.numeroBoleta,
      tbkTesoreriaId: null,
      transbankSaleId: s.id,
      manual: false,
      ficticio: false,
    });
  }

  // Filtros de salida.
  let outRows = rows;
  if (sucursalId !== null && !Number.isNaN(sucursalId)) {
    outRows = outRows.filter((r) => r.sucursalId === sucursalId);
  }
  if (estado) outRows = outRows.filter((r) => r.estado === estado);
  outRows.sort((a, b) => b.fecha.localeCompare(a.fecha));

  // KPIs (sobre todo el rango, sin filtro de estado).
  const cuadrados = rows.filter((r) => r.estado === "cuadrado");
  const kpis = {
    cuadrados: cuadrados.length,
    posSinSettlement: rows.filter((r) => r.estado === "pos_sin_settlement").length,
    settlementSinPos: rows.filter((r) => r.estado === "settlement_sin_pos").length,
    totalBruto: sumStr(cuadrados.map((r) => r.montoBruto)),
    totalComision: sumStr(cuadrados.map((r) => r.comision ?? "0")),
    totalNeto: sumStr(cuadrados.map((r) => r.neto ?? "0")),
    conRecargo: cuadrados.filter((r) => r.diferencia && r.diferencia !== "0").length,
    totalRecargo: sumStr(cuadrados.map((r) => r.diferencia ?? "0")),
  };

  // Facets de sucursal: todas las vistas en POS o settlement (con nombre).
  const sucIds = new Set<number>();
  for (const p of posAll) sucIds.add(p.sucursalId);
  for (const s of settAll) if (s.sucursalId != null) sucIds.add(s.sucursalId);
  const sucursales = Array.from(sucIds)
    .map((id) => ({ id, name: sucName.get(id) ?? null }))
    .sort((a, b) => a.id - b.id);

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    kpis,
    rows: outRows.slice(0, 5000),
    rowsTotal: outRows.length,
    facets: { sucursales },
  });
}

function sumStr(arr: string[]): string {
  let acc = 0n;
  for (const s of arr) acc += BigInt(s || "0");
  return acc.toString();
}

function parseRange(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  if (fromRaw && toRaw) {
    const from = parseDateOnly(fromRaw);
    const to = parseDateOnly(toRaw);
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setDate(toEnd.getDate() + 1);
      return { from, to: toEnd };
    }
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

function parseDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
