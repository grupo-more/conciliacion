import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/branches
 * Devuelve las sucursales conocidas (descubiertas a través de DynatechMovement)
 * con su hint actual (si existe), conteo de movimientos y stats por banco.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  // Sucursales detectadas
  const branches = await prisma.dynatechMovement.groupBy({
    by: ["branchExternalId", "branchExternalName"],
    _count: { _all: true },
    orderBy: [{ branchExternalId: "asc" }],
  });

  // Hints existentes (por id de sucursal)
  const hints = await prisma.branchAccountHint.findMany({
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
  });
  const hintByBranch = new Map(hints.map((h) => [h.branchExternalId, h]));

  // Distribución histórica de matches por sucursal → cuenta
  // (usa ReconciliationLink para soportar 1:N)
  const distribution = await prisma.$queryRaw<
    Array<{
      branch_external_id: number;
      bank_code: string;
      holder_name: string;
      account_id: string;
      n: bigint;
    }>
  >`
    SELECT dm.branch_external_id,
           ba.bank_code,
           ba.holder_name,
           ba.id AS account_id,
           COUNT(DISTINCT r.id)::bigint AS n
    FROM "Reconciliation" r
    JOIN "DynatechMovement" dm ON r.dynatech_movement_id = dm.id
    JOIN "ReconciliationLink" rl ON rl.reconciliation_id = r.id
    JOIN "BankMovement" bm ON rl.bank_movement_id = bm.id
    JOIN "BankAccount" ba ON bm.account_id = ba.id
    WHERE r.status IN ('AUTO_MATCHED','MANUAL')
    GROUP BY dm.branch_external_id, ba.bank_code, ba.holder_name, ba.id
    ORDER BY dm.branch_external_id, n DESC
  `;
  const distByBranch = new Map<
    number,
    Array<{ accountId: string; bankCode: string; holderName: string; n: number }>
  >();
  for (const r of distribution) {
    const arr = distByBranch.get(r.branch_external_id) ?? [];
    arr.push({
      accountId: r.account_id,
      bankCode: r.bank_code,
      holderName: r.holder_name,
      n: Number(r.n),
    });
    distByBranch.set(r.branch_external_id, arr);
  }

  return NextResponse.json({
    branches: branches.map((b) => {
      const hint = hintByBranch.get(b.branchExternalId);
      const dist = distByBranch.get(b.branchExternalId) ?? [];
      const totalConfirmed = dist.reduce((acc, x) => acc + x.n, 0);
      return {
        externalId: b.branchExternalId,
        name: b.branchExternalName,
        movementCount: b._count._all,
        hint: hint
          ? {
              id: hint.id,
              accountId: hint.accountId,
              account: hint.account,
              notes: hint.notes,
            }
          : null,
        history: {
          totalConfirmed,
          distribution: dist.map((x) => ({
            accountId: x.accountId,
            bankCode: x.bankCode,
            holderName: x.holderName,
            count: x.n,
            ratio: totalConfirmed > 0 ? x.n / totalConfirmed : 0,
          })),
        },
      };
    }),
  });
}
