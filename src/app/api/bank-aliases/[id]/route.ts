import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

const patchSchema = z.object({
  accountId: z.string().uuid().optional(),
  notes: z.string().max(500).optional().nullable(),
});

export async function PATCH(
  req: Request,
  context: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }

  const existing = await prisma.bankAccountAlias.findUnique({ where: { id: context.params.id } });
  if (!existing) {
    return NextResponse.json({ error: "Alias no encontrado" }, { status: 404 });
  }

  if (parsed.data.accountId) {
    const acc = await prisma.bankAccount.findUnique({ where: { id: parsed.data.accountId } });
    if (!acc) return NextResponse.json({ error: "Cuenta no existe" }, { status: 404 });
  }

  await prisma.bankAccountAlias.update({
    where: { id: context.params.id },
    data: {
      ...(parsed.data.accountId ? { accountId: parsed.data.accountId } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes?.trim() || null } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  context: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  await prisma.bankAccountAlias.delete({ where: { id: context.params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
