import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAccion } from "@/lib/perms";

/**
 * Gestión de usuarios (Configuración → Usuarios y perfiles).
 * GET  → lista usuarios con su perfil.
 * POST → crea usuario {email, name?, password, perfilId}.
 * Requiere la acción "gestionarUsuarios".
 */
export async function GET() {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const users = await prisma.user.findMany({
    include: { perfil: { select: { id: true, nombre: true, esAdmin: true } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      active: u.active,
      perfilId: u.perfilId,
      perfilNombre: u.perfil?.nombre ?? null,
      esAdmin: u.perfil?.esAdmin ?? false,
      createdAt: u.createdAt.toISOString(),
    })),
  });
}

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().max(120).nullable().optional(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
  perfilId: z.string().min(1),
});

export async function POST(req: Request) {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { email, name, password, perfilId } = parsed.data;

  const perfil = await prisma.perfil.findUnique({ where: { id: perfilId } });
  if (!perfil) return NextResponse.json({ error: "El perfil no existe" }, { status: 400 });

  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const user = await prisma.user.create({
      data: { email, name: name?.trim() || null, passwordHash, perfilId, active: true },
    });
    return NextResponse.json({ ok: true, id: user.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ya existe un usuario con ese email." }, { status: 409 });
    }
    throw e;
  }
}
