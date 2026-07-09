import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Reglas de descarte automático al importar cartolas (Configuración →
 * Descartes automáticos). Un movimiento cuya contraparte o glosa contiene el
 * patrón (case-insensitive) se inserta directo a "Movimientos descartados".
 *
 * GET              → lista todas las reglas (con label de cuenta).
 * POST             → crea {patron, accountId?, nota?}.
 * PATCH  ?id=      → activa/desactiva {active}.
 * DELETE ?id=      → elimina la regla (los ya descartados NO se restauran).
 */

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const reglas = await prisma.descarteRegla.findMany({
    include: {
      account: {
        select: { bankName: true, holderName: true, accountNumber: true, displayNumber: true },
      },
    },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });

  return NextResponse.json({
    reglas: reglas.map((r) => ({
      id: r.id,
      patron: r.patron,
      accountId: r.accountId,
      accountLabel: r.account
        ? `${r.account.bankName} · ${r.account.holderName} · ${r.account.displayNumber ?? r.account.accountNumber}`
        : null,
      active: r.active,
      nota: r.nota,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

const postSchema = z.object({
  patron: z.string().trim().min(3, "El patrón debe tener al menos 3 caracteres").max(120),
  accountId: z.string().uuid().nullable().optional(),
  nota: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "depurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { patron, accountId, nota } = parsed.data;

  if (accountId) {
    const acc = await prisma.bankAccount.findUnique({ where: { id: accountId }, select: { id: true } });
    if (!acc) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
  }

  const created = await prisma.descarteRegla.create({
    data: { patron, accountId: accountId ?? null, nota: nota ?? null, createdById: session.sub },
  });
  return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
}

const patchSchema = z.object({ active: z.boolean() });

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "depurar");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });
  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const regla = await prisma.descarteRegla.findUnique({ where: { id } });
  if (!regla) return NextResponse.json({ error: "Regla no encontrada" }, { status: 404 });

  await prisma.descarteRegla.update({ where: { id }, data: { active: parsed.data.active } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "depurar");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });

  const regla = await prisma.descarteRegla.findUnique({ where: { id } });
  if (!regla) return NextResponse.json({ error: "Regla no encontrada" }, { status: 404 });

  await prisma.descarteRegla.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
