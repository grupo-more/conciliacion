import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

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

  const [posAll, settAll] = await Promise.all([
    prisma.tbkTesoreria.findMany({
      where: { fecha: { gte: from, lt: to } },
      orderBy: { fecha: "desc" },
    }),
    prisma.transbankSale.findMany({
      where: { fechaVenta: { gte: from, lt: to } },
      orderBy: { fechaVenta: "desc" },
    }),
  ]);

  // Índice de settlements por (boleta|monto) y disponibilidad.
  const settByKey = new Map<string, typeof settAll>();
  for (const sv of settAll) {
    if (!sv.numeroBoleta) continue;
    const k = `${sv.numeroBoleta}|${sv.montoVenta.toString()}`;
    (settByKey.get(k) ?? settByKey.set(k, []).get(k)!).push(sv);
  }
  const usedSett = new Set<string>();

  type Pair = { pos: (typeof posAll)[number]; sett: (typeof settAll)[number] | null };
  const pairs: Pair[] = [];

  // Pass 1: primario por boleta(=OP) + monto.
  const unmatchedPos: typeof posAll = [];
  for (const pos of posAll) {
    const op = pos.opNumber;
    let matched: (typeof settAll)[number] | null = null;
    if (op) {
      const k = `${op}|${pos.monto.toString()}`;
      const cands = settByKey.get(k) ?? [];
      matched = cands.find((c) => !usedSett.has(c.id)) ?? null;
    }
    if (matched) {
      usedSett.add(matched.id);
      pairs.push({ pos, sett: matched });
    } else {
      unmatchedPos.push(pos);
    }
  }

  // Pass 2: fallback por monto bruto + fecha (±1d) sobre los aún libres.
  const freeSett = settAll.filter((s) => !usedSett.has(s.id));
  const dayMs = 86400000;
  for (const pos of unmatchedPos) {
    const cand = freeSett.find(
      (s) =>
        !usedSett.has(s.id) &&
        s.montoVenta === pos.monto &&
        Math.abs(pos.fecha.getTime() - s.fechaVenta.getTime()) <= dayMs * 1.5 &&
        (s.sucursalId == null || s.sucursalId === pos.sucursalId),
    );
    if (cand) {
      usedSett.add(cand.id);
      pairs.push({ pos, sett: cand });
    } else {
      pairs.push({ pos, sett: null });
    }
  }

  const settlementOnly = settAll.filter((s) => !usedSett.has(s.id));

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
    tid: string | null;
    boleta: string | null;
  };
  const rows: Row[] = [];

  for (const p of pairs) {
    if (p.sett) {
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
        tid: p.sett.tid,
        boleta: p.sett.numeroBoleta,
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
        tid: null,
        boleta: null,
      });
    }
  }
  for (const s of settlementOnly) {
    rows.push({
      estado: "settlement_sin_pos",
      fecha: s.fechaVenta.toISOString(),
      sucursalId: s.sucursalId,
      sucursalName: null,
      op: null,
      glosa: s.nombreLocal,
      medioPago: s.medioPago,
      montoBruto: s.montoVenta.toString(),
      comision: (s.comision + s.ivaComision).toString(),
      neto: s.totalAbono.toString(),
      tid: s.tid,
      boleta: s.numeroBoleta,
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
  };

  // Facets de sucursal.
  const sucMap = new Map<number, string | null>();
  for (const p of posAll) sucMap.set(p.sucursalId, p.sucursalName);
  const sucursales = Array.from(sucMap.entries())
    .map(([id, name]) => ({ id, name }))
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
