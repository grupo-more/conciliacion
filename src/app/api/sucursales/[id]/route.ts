import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * PATCH  /api/sucursales/[id] → edita nombre / código / headcount / activa / orden.
 * DELETE /api/sucursales/[id] → borra si no tiene asientos; si los tiene, la desactiva.
 */
const patchSchema = z.object({
  codigo: z.number().int().positive().nullable().optional(),
  nombre: z.string().trim().min(1).max(120).optional(),
  headcount: z.number().min(0).max(10000).optional(),
  active: z.boolean().optional(),
  orden: z.number().int().optional(),
});

export async function PATCH(
  req: Request,
  context: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { codigo, nombre, headcount, active, orden } = parsed.data;

  try {
    const updated = await prisma.sucursal.update({
      where: { id: context.params.id },
      data: {
        ...(codigo !== undefined ? { codigo } : {}),
        ...(nombre !== undefined ? { nombre } : {}),
        ...(headcount !== undefined ? { headcount: new Prisma.Decimal(headcount) } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(orden !== undefined ? { orden } : {}),
      },
    });
    return NextResponse.json({
      id: updated.id,
      codigo: updated.codigo,
      nombre: updated.nombre,
      headcount: Number(updated.headcount),
      active: updated.active,
      orden: updated.orden,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") {
        return NextResponse.json(
          { error: `Ya existe una sucursal con código ${codigo}` },
          { status: 409 },
        );
      }
      if (e.code === "P2025") {
        return NextResponse.json({ error: "Sucursal no encontrada" }, { status: 404 });
      }
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  context: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const id = context.params.id;
  const usada = await prisma.asientoManualLinea.count({ where: { sucursalId: id } });
  if (usada > 0) {
    // Tiene asientos históricos: no se borra (rompería la traza), se desactiva.
    await prisma.sucursal.update({ where: { id }, data: { active: false } });
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await prisma.sucursal.delete({ where: { id } });
  return NextResponse.json({ ok: true, deactivated: false });
}
