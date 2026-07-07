import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAccion, normalizePermisos, MODULOS, ACCIONES } from "@/lib/perms";

/**
 * Gestión de perfiles (Configuración → Usuarios y perfiles).
 * GET  → lista perfiles con sus variables (permisos) y cantidad de usuarios.
 * POST → crea un perfil {nombre, permisos}. esAdmin NUNCA se crea por API.
 * Requiere "gestionarUsuarios".
 */
export async function GET() {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const perfiles = await prisma.perfil.findMany({
    include: { _count: { select: { users: true } } },
    orderBy: [{ esAdmin: "desc" }, { nombre: "asc" }],
  });
  return NextResponse.json({
    modulos: MODULOS,
    acciones: ACCIONES,
    perfiles: perfiles.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      esAdmin: p.esAdmin,
      permisos: normalizePermisos(p.permisos),
      userCount: p._count.users,
    })),
  });
}

const permisosSchema = z.object({
  modulos: z.record(z.boolean()),
  acciones: z.record(z.boolean()),
});
const createSchema = z.object({
  nombre: z.string().trim().min(1).max(80),
  permisos: permisosSchema,
});

export async function POST(req: Request) {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }
  try {
    const p = await prisma.perfil.create({
      data: {
        nombre: parsed.data.nombre,
        esAdmin: false,
        permisos: normalizePermisos(parsed.data.permisos) as unknown as Prisma.InputJsonValue,
      },
    });
    return NextResponse.json({ ok: true, id: p.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ya existe un perfil con ese nombre." }, { status: 409 });
    }
    throw e;
  }
}
