import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";
import { normalizeRut } from "@/lib/internos/detect";

/**
 * Maestro de PROVEEDORES (Configuración → Proveedores): define qué movimientos
 * de banco sin conciliar se derivan a la tab "Proveedores" de Consolidados.
 * Match: RUT (certero) + patrones de texto (respaldo). Ver lib/asientos/proveedores.ts.
 */

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const proveedores = await prisma.proveedorAsiento.findMany({
    orderBy: [{ active: "desc" }, { nombre: "asc" }],
  });
  return NextResponse.json({
    proveedores: proveedores.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      rut: p.rut,
      patrones: p.patrones,
      active: p.active,
      nota: p.nota,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}

const upsertSchema = z.object({
  nombre: z.string().trim().min(2).max(120),
  rut: z.string().trim().max(20).nullable().optional(),
  patrones: z.array(z.string().trim().min(3).max(120)).max(20).optional(),
  nota: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }
  const { nombre, nota } = parsed.data;
  const rut = parsed.data.rut ? normalizeRut(parsed.data.rut) : null;
  const patrones = (parsed.data.patrones ?? []).filter(Boolean);
  if (!rut && patrones.length === 0) {
    return NextResponse.json(
      { error: "Definí al menos un RUT o un patrón de texto (si no, nunca matchearía nada)." },
      { status: 400 },
    );
  }

  try {
    const created = await prisma.proveedorAsiento.create({
      data: { nombre, rut: rut || null, patrones, nota: nota ?? null, createdById: session.sub },
    });
    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ya existe un proveedor con ese RUT." }, { status: 409 });
    }
    throw e;
  }
}

const patchSchema = upsertSchema.partial().extend({ active: z.boolean().optional() });

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });
  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const existing = await prisma.proveedorAsiento.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 404 });

  const d = parsed.data;
  try {
    await prisma.proveedorAsiento.update({
      where: { id },
      data: {
        ...(d.nombre !== undefined ? { nombre: d.nombre } : {}),
        ...(d.rut !== undefined ? { rut: d.rut ? normalizeRut(d.rut) : null } : {}),
        ...(d.patrones !== undefined ? { patrones: d.patrones.filter(Boolean) } : {}),
        ...(d.nota !== undefined ? { nota: d.nota } : {}),
        ...(d.active !== undefined ? { active: d.active } : {}),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ya existe un proveedor con ese RUT." }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });
  const existing = await prisma.proveedorAsiento.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 404 });

  await prisma.proveedorAsiento.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
