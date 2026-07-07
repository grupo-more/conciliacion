import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { requireAccion } from "@/lib/perms";

/**
 * PATCH /api/admin/usuarios/[id] — edita un usuario: nombre, perfil, activo,
 * y/o reset de contraseña. Requiere "gestionarUsuarios".
 *
 * Salvaguardas (para no dejarse afuera del sistema):
 *  - No podés desactivarte a vos mismo ni cambiarte el perfil.
 *  - No se puede desactivar ni degradar al ÚLTIMO admin activo.
 */
const patchSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  perfilId: z.string().min(1).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const auth = await requireAccion("gestionarUsuarios");
  if (!auth.ok) return auth.res;
  const selfId = auth.session.sub;
  const targetId = params.id;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { name, perfilId, active, password } = parsed.data;

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    include: { perfil: { select: { esAdmin: true } } },
  });
  if (!target) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });

  // Auto-protección: no tocarte el propio perfil/estado.
  if (targetId === selfId && (active === false || (perfilId && perfilId !== target.perfilId))) {
    return NextResponse.json(
      { error: "No podés desactivarte ni cambiarte el perfil a vos mismo." },
      { status: 400 },
    );
  }

  let newPerfilEsAdmin: boolean | null = null;
  if (perfilId) {
    const perfil = await prisma.perfil.findUnique({ where: { id: perfilId } });
    if (!perfil) return NextResponse.json({ error: "El perfil no existe" }, { status: 400 });
    newPerfilEsAdmin = perfil.esAdmin;
  }

  // Protección del último admin: si el target es admin activo y lo vamos a
  // desactivar o sacar de admin, tiene que quedar al menos otro admin activo.
  const targetEsAdmin = target.perfil?.esAdmin ?? false;
  const pierdeAdmin =
    targetEsAdmin && (active === false || (perfilId && newPerfilEsAdmin === false));
  if (pierdeAdmin) {
    const otrosAdmins = await prisma.user.count({
      where: { id: { not: targetId }, active: true, perfil: { esAdmin: true } },
    });
    if (otrosAdmins === 0) {
      return NextResponse.json(
        { error: "Es el último admin activo: no se puede desactivar ni degradar." },
        { status: 400 },
      );
    }
  }

  await prisma.user.update({
    where: { id: targetId },
    data: {
      ...(name !== undefined ? { name: name?.trim() || null } : {}),
      ...(perfilId ? { perfilId } : {}),
      ...(active !== undefined ? { active } : {}),
      ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}
