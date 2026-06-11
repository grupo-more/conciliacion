import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET  /api/sucursales            → maestro de sucursales (headcount para el prorrateo).
 * POST /api/sucursales            → crea una sucursal.
 *
 * El headcount puede ser fraccionado (ej. 1.5). `codigo` es el sucursalId de
 * Dynatech (207, 202…), opcional y único.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const rows = await prisma.sucursal.findMany({
    orderBy: [{ orden: "asc" }, { nombre: "asc" }],
  });

  return NextResponse.json({
    sucursales: rows.map((s) => ({
      id: s.id,
      codigo: s.codigo,
      nombre: s.nombre,
      headcount: Number(s.headcount),
      active: s.active,
      orden: s.orden,
    })),
  });
}

const createSchema = z.object({
  codigo: z.number().int().positive().nullable().optional(),
  nombre: z.string().trim().min(1).max(120),
  headcount: z.number().min(0).max(10000),
  active: z.boolean().optional(),
  orden: z.number().int().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { codigo, nombre, headcount, active, orden } = parsed.data;

  try {
    const created = await prisma.sucursal.create({
      data: {
        codigo: codigo ?? null,
        nombre,
        headcount: new Prisma.Decimal(headcount),
        active: active ?? true,
        orden: orden ?? 0,
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        codigo: created.codigo,
        nombre: created.nombre,
        headcount: Number(created.headcount),
        active: created.active,
        orden: created.orden,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: `Ya existe una sucursal con código ${codigo}` },
        { status: 409 },
      );
    }
    throw e;
  }
}
