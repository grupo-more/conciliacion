import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/internos/detect";

const patchSchema = z.object({
  rut: z.string().trim().min(1).optional(),
  nombreCanonico: z.string().trim().min(1).max(120).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).optional(),
  rubro: z.number().int().positive().nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos invalidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const data: {
    rutCanonico?: string;
    nombreCanonico?: string;
    aliases?: string[];
    rubro?: number | null;
    notas?: string | null;
    active?: boolean;
  } = {};

  if (parsed.data.rut !== undefined) {
    const rutCanonico = normalizeRut(parsed.data.rut);
    if (rutCanonico.length < 7) {
      return NextResponse.json({ error: "RUT invalido" }, { status: 400 });
    }
    data.rutCanonico = rutCanonico;
  }
  if (parsed.data.nombreCanonico !== undefined) {
    data.nombreCanonico = parsed.data.nombreCanonico;
  }
  if (parsed.data.aliases !== undefined) {
    data.aliases = dedupeAliases(parsed.data.aliases);
  }
  if (parsed.data.rubro !== undefined) data.rubro = parsed.data.rubro;
  if (parsed.data.notas !== undefined) data.notas = parsed.data.notas;
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios" }, { status: 400 });
  }

  try {
    const updated = await prisma.entidadInterna.update({
      where: { id: params.id },
      data,
    });
    return NextResponse.json({
      id: updated.id,
      rutCanonico: updated.rutCanonico,
      nombreCanonico: updated.nombreCanonico,
      aliases: updated.aliases,
      rubro: updated.rubro,
      notas: updated.notas,
      active: updated.active,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2025") {
        return NextResponse.json(
          { error: "Entidad no encontrada" },
          { status: 404 },
        );
      }
      if (e.code === "P2002") {
        return NextResponse.json(
          { error: "Ya existe una entidad con ese RUT" },
          { status: 409 },
        );
      }
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    await prisma.entidadInterna.delete({ where: { id: params.id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Entidad no encontrada" },
        { status: 404 },
      );
    }
    throw e;
  }
}

function dedupeAliases(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const trimmed = a.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(trimmed);
  }
  return out;
}
