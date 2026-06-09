import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { detectInterno, loadEntidadesInternas } from "@/lib/internos/detect";
import {
  parseRange,
  agingBucket,
  bankTag,
  AGING_BUCKETS,
  CONCILIADO_STATUSES,
  type AgingBucket,
  type BankTag,
} from "@/lib/reportes/classify";

const TAKE = 5000;

/**
 * GET /api/reportes/banco-sin-conciliar
 *   ?from&to&accountId&direction=IN|OUT&tag=interno|transbank|comision|sin_clasificar
 *
 * Movimientos de cartola (BankMovement) SIN conciliar: sin ningun
 * ConsolidadoLink a un Consolidado AUTO_MATCHED/MANUAL. Cada fila se etiqueta
 * (interno / transbank / comision / sin_clasificar) para separar el ruido
 * esperado de la brecha real, y se le calcula la antiguedad (aging).
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
  const accountId = url.searchParams.get("accountId") || null;
  const directionFilter = url.searchParams.get("direction");
  const tagFilter = (url.searchParams.get("tag") as BankTag | null) || null;

  const entidades = await loadEntidadesInternas(prisma);
  const now = new Date();

  const movements = await prisma.bankMovement.findMany({
    where: {
      postDate: { gte: from, lt: to },
      ...(accountId ? { accountId } : {}),
      ...(directionFilter === "IN" || directionFilter === "OUT"
        ? { direction: directionFilter }
        : {}),
      NOT: {
        consolidadoLinks: {
          some: { consolidado: { status: { in: [...CONCILIADO_STATUSES] } } },
        },
      },
    },
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
        },
      },
    },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    take: TAKE,
  });

  const rows: BancoRow[] = [];
  const accountSet = new Map<string, string>(); // id -> label

  // Acumuladores de resumen
  let count = 0;
  let montoAbs = 0n;
  const porDireccion = mkAmountMap(["IN", "OUT"]);
  const porTag = mkAmountMap<BankTag>([
    "interno",
    "transbank",
    "comision",
    "sin_clasificar",
  ]);
  const porAging = mkAmountMap<AgingBucket>([...AGING_BUCKETS]);
  const porBanco = new Map<string, { label: string; count: number; monto: bigint }>();

  for (const bm of movements) {
    const esInterno = detectInterno(bm, entidades) !== null;
    const tag = bankTag(esInterno, bm.description, bm.counterpartyName);
    if (tagFilter && tag !== tagFilter) continue;

    const abs = bm.amount < 0n ? -bm.amount : bm.amount;
    const { days, bucket } = agingBucket(bm.postDate, now);
    const cuentaNumero = bm.account.displayNumber || bm.account.accountNumber;
    const cuentaLabel = [bm.account.bankName, bm.account.holderName, cuentaNumero]
      .filter((s) => s && s.trim().length > 0)
      .join(" · ");
    accountSet.set(bm.account.id, cuentaLabel);

    // Resumen
    count++;
    montoAbs += abs;
    bump(porDireccion, bm.direction, abs);
    bump(porTag, tag, abs);
    bump(porAging, bucket, abs);
    const bk = porBanco.get(bm.account.id) ?? {
      label: cuentaLabel,
      count: 0,
      monto: 0n,
    };
    bk.count++;
    bk.monto += abs;
    porBanco.set(bm.account.id, bk);

    rows.push({
      id: bm.id,
      fecha: bm.postDate.toISOString(),
      aging: days,
      agingBucket: bucket,
      direction: bm.direction,
      accountId: bm.account.id,
      bankName: bm.account.bankName,
      holderName: bm.account.holderName,
      accountNumber: cuentaNumero,
      monto: abs.toString(),
      tag,
      counterpartyName: bm.counterpartyName,
      counterpartyRut: bm.counterpartyRut,
      description: bm.description,
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
      porDireccion: dumpAmountMap(porDireccion),
      porTag: dumpAmountMap(porTag),
      porAging: dumpAmountMap(porAging),
      porBanco: [...porBanco.values()]
        .map((b) => ({ label: b.label, count: b.count, monto: b.monto.toString() }))
        .sort((a, b) => Number(BigInt(b.monto) - BigInt(a.monto))),
    },
    facets: {
      accounts: [...accountSet.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  });
}

/* ============================== Tipos ============================== */

interface BancoRow {
  id: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  direction: string;
  accountId: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  tag: BankTag;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  description: string | null;
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
