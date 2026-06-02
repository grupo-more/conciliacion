import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  TRANSBANK_RUBRO_BANCO,
  TRANSBANK_RUBRO_CONTRA,
  transbankPrismaWhere,
} from "@/lib/transbank/detect";

/**
 * GET /api/consolidados/abono-transbank?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=
 *
 * Arma el asiento contable de los abonos Transbank: ingresos al banco con
 * glosa tipo "ABN CRD DB TRAN TRANSBA" que NO se concilian con Tesorería.
 *
 * Cada BankMovement genera 2 filas:
 *  - Debe rubro 230 (banco)   por el monto del movimiento
 *  - Haber rubro 17 (Transbank por liquidar)
 *
 * No hay deshacer porque no hay match contra TesoreriaMovement — la vista es
 * un derivado puro de BankMovement + el patrón de glosa.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );
  const accountId = url.searchParams.get("accountId") || null;

  const movements = await prisma.bankMovement.findMany({
    where: {
      ...transbankPrismaWhere,
      postDate: { gte: from, lt: to },
      ...(accountId ? { accountId } : {}),
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
    take: 2000,
  });

  // Etiquetas de los 2 rubros que usa este asiento.
  const rubroLabels = await prisma.rubroLabel.findMany({
    where: { rubro: { in: [TRANSBANK_RUBRO_BANCO, TRANSBANK_RUBRO_CONTRA] } },
    select: { rubro: true, name: true },
  });
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));
  const labelBanco = labelByRubro.get(TRANSBANK_RUBRO_BANCO) ?? "Banco";
  const labelContra = labelByRubro.get(TRANSBANK_RUBRO_CONTRA) ?? "Transbank";

  const rows: AbonoTransbankRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const bm of movements) {
    const abs = bm.amount < 0n ? -bm.amount : bm.amount;
    const glosa = bm.description?.trim() || "";
    const cliente = bm.counterpartyName?.trim() || labelContra;
    const groupId = bm.id;

    // 1) Fila lado banco — Debe
    rows.push({
      groupId,
      side: "BANCO",
      fecha: bm.postDate.toISOString(),
      rubro: TRANSBANK_RUBRO_BANCO,
      rubroLabel: labelBanco,
      detalle: bm.account.bankName,
      cuenta: bm.account.displayNumber || bm.account.accountNumber,
      cliente,
      glosa,
      debe: abs.toString(),
      haber: null,
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });
    totalDebe += abs;

    // 2) Fila contracuenta Transbank — Haber
    rows.push({
      groupId,
      side: "TRANSBANK",
      fecha: bm.postDate.toISOString(),
      rubro: TRANSBANK_RUBRO_CONTRA,
      rubroLabel: labelContra,
      detalle: labelContra,
      cuenta: bm.account.displayNumber || bm.account.accountNumber,
      cliente,
      glosa,
      debe: null,
      haber: abs.toString(),
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });
    totalHaber += abs;
  }

  // Facets: cuentas vistas en el rango completo (no afectado por filtro de cuenta).
  const allInRange = await prisma.bankMovement.findMany({
    where: {
      ...transbankPrismaWhere,
      postDate: { gte: from, lt: to },
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const accountIds = allInRange.map((r) => r.accountId);
  const accountList =
    accountIds.length > 0
      ? await prisma.bankAccount.findMany({
          where: { id: { in: accountIds } },
          select: {
            id: true,
            bankName: true,
            displayNumber: true,
            accountNumber: true,
            holderName: true,
          },
        })
      : [];

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: { debe: totalDebe.toString(), haber: totalHaber.toString() },
    facets: {
      accounts: accountList
        .map((a) => ({
          id: a.id,
          label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  });
}

interface AbonoTransbankRow {
  /** Identificador del grupo (bankMovementId). Filas con mismo groupId pertenecen al mismo asiento. */
  groupId: string;
  side: "BANCO" | "TRANSBANK";
  fecha: string;
  rubro: number;
  rubroLabel: string;
  detalle: string;
  cuenta: string;
  cliente: string;
  glosa: string;
  debe: string | null;
  haber: string | null;
  bankMovementId: string;
  totalMonto: string;
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null
): { from: Date; to: Date } {
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
