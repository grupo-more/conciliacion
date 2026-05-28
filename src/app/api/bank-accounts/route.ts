import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { UNASSIGNED_PREFIX, isUnassignedAccountNumber } from "@/lib/cartolas/import";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { active: true },
    orderBy: [
      // Las "Sin asignar" al final
      { accountNumber: "asc" },
      { bankName: "asc" },
    ],
  });

  // Conteo de movimientos por cuenta (para badges)
  const counts = await prisma.bankMovement.groupBy({
    by: ["accountId"],
    _count: { _all: true },
  });
  const countByAccount = new Map(counts.map((c) => [c.accountId, c._count._all]));

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      bankCode: a.bankCode,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      displayNumber: a.displayNumber,
      holderName: a.holderName,
      holderRut: a.holderRut,
      currency: a.currency,
      alias: a.alias,
      purpose: a.purpose,
      accountingRubro: a.accountingRubro,
      isUnassigned: isUnassignedAccountNumber(a.accountNumber),
      movementCount: countByAccount.get(a.id) ?? 0,
    })),
  });
}
