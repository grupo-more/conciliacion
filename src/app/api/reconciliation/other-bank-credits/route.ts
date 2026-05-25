import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/reconciliation/other-bank-credits
 *
 * Devuelve los abonos bancarios (BankMovement direction='IN') que NO están
 * conciliados con ningún Dynatech. Panel solo informativo: estos son típicamente
 * transferencias directas de clientes que no pasan por cierres de caja.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);

  const where: Prisma.BankMovementWhereInput = {
    direction: "IN",
    reconciliationLinks: { none: {} },
    ...(accountId ? { accountId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.bankMovement.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { postDate: "desc" },
      include: {
        account: {
          select: {
            bankCode: true,
            bankName: true,
            holderName: true,
            displayNumber: true,
            accountNumber: true,
          },
        },
      },
    }),
    prisma.bankMovement.count({ where }),
  ]);

  return NextResponse.json({
    total,
    limit,
    offset,
    movements: rows.map((m) => ({
      id: m.id,
      accountId: m.accountId,
      account: m.account,
      postDate: m.postDate.toISOString(),
      amount: m.amount.toString(),
      currency: m.currency,
      description: m.description,
      counterpartyName: m.counterpartyName,
      counterpartyRut: m.counterpartyRut,
      externalId: m.externalId,
    })),
  });
}

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
