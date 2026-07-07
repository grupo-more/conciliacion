import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPermisosForUser } from "@/lib/perms";

/**
 * GET /api/auth/me — usuario de la sesión + permisos efectivos FRESCOS de BD
 * (el JWT no lleva permisos; editar un perfil aplica al próximo request).
 * La UI usa esto para gatear sidebar/botones (el enforcement real está en las
 * rutas de mutación vía denyUnless).
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  const p = await getPermisosForUser(session.sub);
  if (!p || !p.active) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({
    user: { id: session.sub, email: session.email, name: session.name },
    esAdmin: p.esAdmin,
    perfilNombre: p.perfilNombre,
    permisos: p.permisos,
  });
}
