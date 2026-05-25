import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * GET /api/reconciliation?status=AUTO_MATCHED|SUGGESTED|REVIEW|NO_MATCH|OUT_OF_SCOPE|MANUAL
 *   ?branchId=  ?since=  ?until=  ?limit=  ?offset=
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const branchId = url.searchParams.get("branchId");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);

  const where: Prisma.ReconciliationWhereInput = {};
  if (status) where.status = status;

  if (branchId || since || until) {
    where.dynatechMovement = {};
    if (branchId) {
      const n = parseInt(branchId, 10);
      if (!Number.isNaN(n)) where.dynatechMovement.branchExternalId = n;
    }
    if (since || until) {
      where.dynatechMovement.occurredAt = {};
      if (since) where.dynatechMovement.occurredAt.gte = new Date(since);
      if (until) {
        const end = new Date(until);
        end.setDate(end.getDate() + 1);
        where.dynatechMovement.occurredAt.lt = end;
      }
    }
  }

  const [rows, totalForFilter, counts, branches, ventasSinProcesar] = await Promise.all([
    prisma.reconciliation.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { matchedAt: "desc" },
      include: {
        dynatechMovement: true,
        links: {
          include: {
            bankMovement: {
              include: {
                account: {
                  select: {
                    bankCode: true,
                    bankName: true,
                    accountNumber: true,
                    displayNumber: true,
                    holderName: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.reconciliation.count({ where }),
    prisma.reconciliation.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.dynatechMovement.groupBy({
      by: ["branchExternalId", "branchExternalName"],
      orderBy: [{ branchExternalId: "asc" }],
    }),
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM "DynatechMovement" dm
      LEFT JOIN "Reconciliation" r ON r.dynatech_movement_id = dm.id
      WHERE r.id IS NULL
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(dm.items) AS item
          WHERE (item->>'nombre') ILIKE 'Venta%'
        )
    `,
  ]);

  return NextResponse.json({
    total: totalForFilter,
    limit,
    offset,
    rows: rows.map(serialize),
    counts: {
      AUTO_MATCHED: counts.find((c) => c.status === "AUTO_MATCHED")?._count._all ?? 0,
      SUGGESTED: counts.find((c) => c.status === "SUGGESTED")?._count._all ?? 0,
      REVIEW: counts.find((c) => c.status === "REVIEW")?._count._all ?? 0,
      MANUAL: counts.find((c) => c.status === "MANUAL")?._count._all ?? 0,
      NO_MATCH: counts.find((c) => c.status === "NO_MATCH")?._count._all ?? 0,
      OUT_OF_SCOPE: counts.find((c) => c.status === "OUT_OF_SCOPE")?._count._all ?? 0,
      UNPROCESSED: Number(ventasSinProcesar[0]?.n ?? 0),
    },
    facets: {
      branches: branches.map((b) => ({
        id: b.branchExternalId,
        name: b.branchExternalName,
      })),
    },
  });
}

function serialize(r: ReconciliationWithIncludes) {
  // Suma de los bank movements asociados
  const banksSum = r.links.reduce((acc, l) => acc + l.bankMovement.amount, 0n);
  return {
    id: r.id,
    status: r.status,
    matchType: r.matchType,
    outOfScopeReason: r.outOfScopeReason,
    notes: r.notes,
    matchedAt: r.matchedAt.toISOString(),
    dynatech: {
      id: r.dynatechMovement.id,
      mCjId: r.dynatechMovement.mCjId.toString(),
      branchExternalId: r.dynatechMovement.branchExternalId,
      branchExternalName: r.dynatechMovement.branchExternalName,
      cashierUsername: r.dynatechMovement.cashierUsername,
      cashierName: r.dynatechMovement.cashierName,
      customerName: r.dynatechMovement.customerName,
      customerRut: r.dynatechMovement.customerRut,
      occurredAt: r.dynatechMovement.occurredAt.toISOString(),
      observation: r.dynatechMovement.observation,
      totalAmount: r.dynatechMovement.totalAmount.toString(),
      currency: r.dynatechMovement.currency,
      items: r.dynatechMovement.items,
      documentCode: r.dynatechMovement.documentCode,
      documentFolio: r.dynatechMovement.documentFolio.toString(),
    },
    banks: r.links.map((l) => ({
      linkId: l.id,
      id: l.bankMovement.id,
      accountId: l.bankMovement.accountId,
      account: l.bankMovement.account,
      postDate: l.bankMovement.postDate.toISOString(),
      amount: l.bankMovement.amount.toString(),
      currency: l.bankMovement.currency,
      description: l.bankMovement.description,
      counterpartyName: l.bankMovement.counterpartyName,
      counterpartyRut: l.bankMovement.counterpartyRut,
      externalId: l.bankMovement.externalId,
    })),
    banksSum: banksSum.toString(),
    bankCount: r.links.length,
  };
}

type ReconciliationWithIncludes = Awaited<
  ReturnType<typeof prisma.reconciliation.findMany<{
    include: {
      dynatechMovement: true;
      links: {
        include: {
          bankMovement: {
            include: {
              account: {
                select: {
                  bankCode: true; bankName: true; accountNumber: true;
                  displayNumber: true; holderName: true;
                };
              };
            };
          };
        };
      };
    };
  }>>
>[number];

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
