import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAccion, normalizePermisos } from "@/lib/perms";

/**
 * PATCH  /api/admin/perfiles/[id] — edita nombre y/o variables (permisos).
 * DELETE /api/admin/perfiles/[id] — elimina el perfil (solo sin usuarios).
 * El perfil esAdmin es intocable (ni editar permisos ni eliminar): garantiza
 * que siempre exista un perfil con acceso total.
 */
const patchSchema = z.object({
  nombre: z.string().trim().min(1).max(80).optional(),
  permisos: z
    .object({ modulos: z.record(z.boolean()), acciones: z.record(z.boolean()) })
    .optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const perfil = await prisma.perfil.findUnique({ where: { id: params.id } });
  if (!perfil) return NextResponse.json({ error: "Perfil no encontrado" }, { status: 404 });

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  if (perfil.esAdmin && parsed.data.permisos) {
    return NextResponse.json(
      { error: "El perfil Admin tiene acceso total: sus variables no se editan." },
      { status: 400 },
    );
  }

  try {
    await prisma.perfil.update({
      where: { id: perfil.id },
      data: {
        ...(parsed.data.nombre ? { nombre: parsed.data.nombre } : {}),
        ...(parsed.data.permisos
          ? { permisos: normalizePermisos(parsed.data.permisos) as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ya existe un perfil con ese nombre." }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const perfil = await prisma.perfil.findUnique({
    where: { id: params.id },
    include: { _count: { select: { users: true } } },
  });
  if (!perfil) return NextResponse.json({ error: "Perfil no encontrado" }, { status: 404 });
  if (perfil.esAdmin) {
    return NextResponse.json({ error: "El perfil Admin no se puede eliminar." }, { status: 400 });
  }
  if (perfil._count.users > 0) {
    return NextResponse.json(
      { error: `Tiene ${perfil._count.users} usuario(s) asignado(s). Reasignalos primero.` },
      { status: 400 },
    );
  }
  await prisma.perfil.delete({ where: { id: perfil.id } });
  return NextResponse.json({ ok: true });
}
