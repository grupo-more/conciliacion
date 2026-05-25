import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isUnassignedAccountNumber } from "@/lib/cartolas/import";

const bodySchema = z.object({
  movementIds: z.array(z.string().uuid()).min(1).max(2000),
  targetAccountId: z.string().uuid(),
});

/**
 * POST /api/cartolas/reassign
 * Mueve los movimientos seleccionados a la cuenta destino.
 *
 * Reglas:
 *  - Solo permite reasignar entre cuentas del MISMO banco (bankCode).
 *  - Si un movimiento ya existe en la cuenta destino (mismo dedupKey),
 *    se elimina el huérfano (no se duplica).
 *  - Si no existe, se actualiza accountId.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { movementIds, targetAccountId } = parsed.data;

  const target = await prisma.bankAccount.findUnique({
    where: { id: targetAccountId },
  });
  if (!target) {
    return NextResponse.json(
      { error: "Cuenta destino no existe" },
      { status: 404 }
    );
  }
  if (isUnassignedAccountNumber(target.accountNumber)) {
    return NextResponse.json(
      { error: "No puedes reasignar a una cuenta 'Sin asignar'" },
      { status: 400 }
    );
  }

  const movements = await prisma.bankMovement.findMany({
    where: { id: { in: movementIds } },
    include: { account: { select: { bankCode: true, accountNumber: true } } },
  });

  if (movements.length === 0) {
    return NextResponse.json(
      { error: "No se encontraron movimientos" },
      { status: 404 }
    );
  }

  // Validar mismo banco
  const wrongBank = movements.find((m) => m.account.bankCode !== target.bankCode);
  if (wrongBank) {
    return NextResponse.json(
      {
        error: `Solo se puede reasignar entre cuentas del mismo banco (${target.bankCode})`,
      },
      { status: 400 }
    );
  }

  // Cuáles ya existen en la cuenta destino (por dedupKey)?
  const dedupKeys = movements.map((m) => m.dedupKey);
  const alreadyInTarget = await prisma.bankMovement.findMany({
    where: {
      accountId: targetAccountId,
      dedupKey: { in: dedupKeys },
      id: { notIn: movementIds }, // no contarse a sí mismos si ya estuvieran
    },
    select: { dedupKey: true },
  });
  const existingSet = new Set(alreadyInTarget.map((x) => x.dedupKey));

  const toMove = movements.filter((m) => !existingSet.has(m.dedupKey));
  const toDelete = movements.filter((m) => existingSet.has(m.dedupKey));

  await prisma.$transaction(async (tx) => {
    if (toMove.length > 0) {
      await tx.bankMovement.updateMany({
        where: { id: { in: toMove.map((m) => m.id) } },
        data: { accountId: targetAccountId },
      });
    }
    if (toDelete.length > 0) {
      await tx.bankMovement.deleteMany({
        where: { id: { in: toDelete.map((m) => m.id) } },
      });
    }
  });

  return NextResponse.json({
    moved: toMove.length,
    deletedAsDuplicate: toDelete.length,
    targetAccountId,
  });
}
