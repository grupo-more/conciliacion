import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PUT /api/branches/[id]/hint
 * Body: { accountId: string, notes?: string }
 *
 * DELETE /api/branches/[id]/hint
 *
 * El [id] es el branchExternalId (entero de Dynatech).
 */

const bodySchema = z.object({
  accountId: z.string().uuid(),
  notes: z.string().optional(),
});

export async function PUT(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const branchExternalId = parseInt(params.id, 10);
  if (Number.isNaN(branchExternalId)) {
    return NextResponse.json({ error: "branchId inválido" }, { status: 400 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Validar que la cuenta exista y no sea "Sin asignar"
  const account = await prisma.bankAccount.findUnique({
    where: { id: parsed.data.accountId },
  });
  if (!account) {
    return NextResponse.json({ error: "Cuenta no existe" }, { status: 404 });
  }
  if (account.accountNumber.startsWith("_UNASSIGNED_")) {
    return NextResponse.json(
      { error: "No puedes asignar una cuenta 'Sin asignar' como hint" },
      { status: 400 }
    );
  }

  // Resolver el nombre de la sucursal (lo guardamos para no perderlo si la sucursal
  // deja de aparecer en Dynatech)
  const sample = await prisma.dynatechMovement.findFirst({
    where: { branchExternalId },
    select: { branchExternalName: true },
  });

  const hint = await prisma.branchAccountHint.upsert({
    where: { branchExternalId },
    create: {
      branchExternalId,
      branchName: sample?.branchExternalName ?? null,
      accountId: parsed.data.accountId,
      notes: parsed.data.notes,
    },
    update: {
      accountId: parsed.data.accountId,
      notes: parsed.data.notes,
    },
  });

  return NextResponse.json({ ok: true, hintId: hint.id });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const branchExternalId = parseInt(params.id, 10);
  if (Number.isNaN(branchExternalId)) {
    return NextResponse.json({ error: "branchId inválido" }, { status: 400 });
  }

  await prisma.branchAccountHint.deleteMany({
    where: { branchExternalId },
  });

  return NextResponse.json({ ok: true });
}
