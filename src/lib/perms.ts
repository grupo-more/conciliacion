import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  ACCION_LABELS,
  PERMISOS_SOLO_LECTURA,
  PERMISOS_TODO,
  buildPermisos,
  normalizePermisos,
  type Accion,
  type Permisos,
} from "@/lib/perms-shared";

/**
 * Perfiles de uso del sistema — lado SERVER (enforcement).
 *
 * Dos familias de "variables" por perfil (ver perms-shared.ts):
 *  - modulos: qué secciones VE el usuario (gating de navegación/UI).
 *  - acciones: qué OPERACIONES puede ejecutar (gating real, en las rutas API
 *    de mutación vía denyUnless()).
 *
 * Los permisos se leen SIEMPRE de la BD (no del JWT): editar un perfil aplica
 * al instante, sin esperar que venza el token. esAdmin bypasea todo.
 * Usuario sin perfil → Solo lectura (mínimo privilegio).
 */

export * from "@/lib/perms-shared";

export interface PermisosUsuario {
  esAdmin: boolean;
  permisos: Permisos;
  perfilId: string | null;
  perfilNombre: string | null;
  active: boolean;
}

/** Permisos efectivos del usuario, frescos desde la BD. */
export async function getPermisosForUser(userId: string): Promise<PermisosUsuario | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { perfil: true },
  });
  if (!user) return null;
  if (!user.active) {
    return { esAdmin: false, permisos: buildPermisos(false, false), perfilId: null, perfilNombre: null, active: false };
  }
  if (user.perfil?.esAdmin) {
    return { esAdmin: true, permisos: PERMISOS_TODO, perfilId: user.perfilId, perfilNombre: user.perfil.nombre, active: true };
  }
  return {
    esAdmin: false,
    permisos: user.perfil ? normalizePermisos(user.perfil.permisos) : PERMISOS_SOLO_LECTURA,
    perfilId: user.perfilId,
    perfilNombre: user.perfil?.nombre ?? null,
    active: true,
  };
}

/**
 * Guard de acción para rutas de MUTACIÓN. Se usa DESPUÉS del check de sesión:
 *
 *   const session = await getSession();
 *   if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
 *   const denied = await denyUnless(session, "conciliar");
 *   if (denied) return denied;
 *
 * Devuelve el NextResponse de rechazo (403/401) o null si tiene permiso.
 */
export async function denyUnless(
  session: SessionPayload,
  accion: Accion,
): Promise<NextResponse | null> {
  const p = await getPermisosForUser(session.sub);
  if (!p || !p.active) {
    return NextResponse.json({ error: "Usuario inactivo o inexistente." }, { status: 401 });
  }
  if (p.esAdmin || p.permisos.acciones[accion]) return null;
  return NextResponse.json(
    { error: `No tenés permiso para esta acción (requiere "${ACCION_LABELS[accion]}").` },
    { status: 403 },
  );
}

/** Igual que denyUnless pero resolviendo la sesión (para rutas nuevas). */
export async function requireAccion(
  accion: Accion,
): Promise<{ ok: true; session: SessionPayload } | { ok: false; res: NextResponse }> {
  const session = await getSession();
  if (!session) {
    return { ok: false, res: NextResponse.json({ error: "No autorizado" }, { status: 401 }) };
  }
  const denied = await denyUnless(session, accion);
  if (denied) return { ok: false, res: denied };
  return { ok: true, session };
}
