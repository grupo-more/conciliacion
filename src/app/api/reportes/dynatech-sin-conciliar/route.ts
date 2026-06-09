import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  parseRange,
  agingBucket,
  dynatechMotivo,
  AGING_BUCKETS,
  CONCILIADO_STATUSES,
  type AgingBucket,
  type DynatechMotivo,
} from "@/lib/reportes/classify";

const TAKE = 5000;

/**
 * GET /api/reportes/dynatech-sin-conciliar
 *   ?from&to&banco&tipo=INGRESO|EGRESO&motivo=<DynatechMotivo>
 *
 * Movimientos de Dynatech (TesoreriaMovement) SIN contraparte conciliada en
 * banco: su Consolidado no es AUTO_MATCHED/MANUAL (incluye los que no tienen
 * Consolidado). Cada fila trae el MOTIVO (sin procesar / sugerido / revisar /
 * excepcion / sin match / fuera de scope) y su antiguedad.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  const bancoFilter = url.searchParams.get("banco") || null;
  const tipoFilter = url.searchParams.get("tipo");
  const motivoFilter = (url.searchParams.get("motivo") as DynatechMotivo | null) || null;

  const now = new Date();

  const movements = await prisma.tesoreriaMovement.findMany({
    where: {
      fecha: { gte: from, lt: to },
      ...(bancoFilter ? { banco: bancoFilter } : {}),
      ...(tipoFilter === "INGRESO" || tipoFilter === "EGRESO"
        ? { tipoOperacion: tipoFilter }
        : {}),
      NOT: { consolidado: { status: { in: [...CONCILIADO_STATUSES] } } },
    },
    select: {
      id: true,
      externalId: true,
      fecha: true,
      monto: true,
      tipoOperacion: true,
      banco: true,
      glosa: true,
      folio: true,
      sucursalName: true,
      sucursalId: true,
      clienteName: true,
      clienteRut: true,
      esExcepcion: true,
      consolidado: { select: { status: true } },
    },
    orderBy: [{ fecha: "desc" }],
    take: TAKE,
  });

  const rows: DynatechRow[] = [];
  const bancoSet = new Set<string>();

  let count = 0;
  let montoAbs = 0n;
  const porTipo = mkAmountMap(["INGRESO", "EGRESO"]);
  const porMotivo = mkAmountMap<DynatechMotivo>([
    "sin_procesar",
    "sugerido",
    "revisar",
    "excepcion",
    "sin_match",
    "fuera_scope",
  ]);
  const porAging = mkAmountMap<AgingBucket>([...AGING_BUCKETS]);
  const porBanco = new Map<string, { count: number; monto: bigint }>();

  for (const tm of movements) {
    const motivo = dynatechMotivo(tm.consolidado?.status, tm.esExcepcion);
    if (motivoFilter && motivo !== motivoFilter) continue;

    const abs = tm.monto < 0n ? -tm.monto : tm.monto;
    const { days, bucket } = agingBucket(tm.fecha, now);
    if (tm.banco) bancoSet.add(tm.banco);

    count++;
    montoAbs += abs;
    bump(porTipo, tm.tipoOperacion === "EGRESO" ? "EGRESO" : "INGRESO", abs);
    bump(porMotivo, motivo, abs);
    bump(porAging, bucket, abs);
    const bk = tm.banco ?? "—";
    const be = porBanco.get(bk) ?? { count: 0, monto: 0n };
    be.count++;
    be.monto += abs;
    porBanco.set(bk, be);

    rows.push({
      id: tm.id,
      externalId: tm.externalId.toString(),
      fecha: tm.fecha.toISOString(),
      aging: days,
      agingBucket: bucket,
      tipoOperacion: tm.tipoOperacion === "EGRESO" ? "EGRESO" : "INGRESO",
      monto: abs.toString(),
      banco: tm.banco,
      sucursalName: tm.sucursalName,
      sucursalId: tm.sucursalId,
      clienteName: tm.clienteName,
      clienteRut: tm.clienteRut,
      glosa: tm.glosa,
      folio: tm.folio.toString(),
      motivo,
    });
  }

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    truncated: movements.length === TAKE,
    rows,
    resumen: {
      count,
      monto: montoAbs.toString(),
      porTipo: dumpAmountMap(porTipo),
      porMotivo: dumpAmountMap(porMotivo),
      porAging: dumpAmountMap(porAging),
      porBanco: [...porBanco.entries()]
        .map(([label, b]) => ({ label, count: b.count, monto: b.monto.toString() }))
        .sort((a, b) => Number(BigInt(b.monto) - BigInt(a.monto))),
    },
    facets: {
      bancos: [...bancoSet].sort((a, b) => a.localeCompare(b)),
    },
  });
}

/* ============================== Tipos ============================== */

interface DynatechRow {
  id: string;
  externalId: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  banco: string | null;
  sucursalName: string | null;
  sucursalId: number;
  clienteName: string | null;
  clienteRut: string | null;
  glosa: string;
  folio: string;
  motivo: DynatechMotivo;
}

/* ============================== Helpers ============================== */

function mkAmountMap<K extends string>(
  keys: K[],
): Map<K, { count: number; monto: bigint }> {
  const m = new Map<K, { count: number; monto: bigint }>();
  for (const k of keys) m.set(k, { count: 0, monto: 0n });
  return m;
}

function bump<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
  key: K,
  abs: bigint,
) {
  const e = m.get(key);
  if (!e) return;
  e.count++;
  e.monto += abs;
}

function dumpAmountMap<K extends string>(
  m: Map<K, { count: number; monto: bigint }>,
): Record<K, { count: number; monto: string }> {
  const out = {} as Record<K, { count: number; monto: string }>;
  for (const [k, v] of m.entries()) {
    out[k] = { count: v.count, monto: v.monto.toString() };
  }
  return out;
}
