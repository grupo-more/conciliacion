import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const direction = url.searchParams.get("direction"); // "IN" | "OUT"
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const search = url.searchParams.get("q");
  const minAmount = url.searchParams.get("minAmount");
  const maxAmount = url.searchParams.get("maxAmount");
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);

  const where: Prisma.BankMovementWhereInput = {};
  if (accountId) where.accountId = accountId;
  if (direction === "IN" || direction === "OUT") where.direction = direction;

  if (since || until) {
    where.postDate = {};
    if (since) (where.postDate as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.postDate as Prisma.DateTimeFilter).lt = end;
    }
  }

  if (minAmount || maxAmount) {
    where.amount = {};
    if (minAmount) (where.amount as Prisma.BigIntFilter).gte = BigInt(minAmount);
    if (maxAmount) (where.amount as Prisma.BigIntFilter).lte = BigInt(maxAmount);
  }

  if (search && search.trim() !== "") {
    where.OR = [
      { description: { contains: search, mode: "insensitive" } },
      { counterpartyName: { contains: search, mode: "insensitive" } },
      { counterpartyRut: { contains: search, mode: "insensitive" } },
      { externalId: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.bankMovement.findMany({
      where,
      orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
      take: limit,
      skip: offset,
      include: {
        account: {
          select: {
            id: true,
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
      externalId: m.externalId,
      postDate: m.postDate.toISOString(),
      transactionDate: m.transactionDate?.toISOString() ?? null,
      amount: m.amount.toString(),
      currency: m.currency,
      direction: m.direction,
      description: m.description,
      balanceAfter: m.balanceAfter?.toString() ?? null,
      counterpartyName: m.counterpartyName,
      counterpartyRut: m.counterpartyRut,
      counterpartyBank: m.counterpartyBank,
      branchLabel: m.branchLabel,
      txType: m.txType,
    })),
  });
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
