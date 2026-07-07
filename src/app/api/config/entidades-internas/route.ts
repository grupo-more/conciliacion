import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeRut } from "@/lib/internos/detect";
import { denyUnless } from "@/lib/perms";

const createSchema = z.object({
  rut: z.string().trim().min(1),
  nombreCanonico: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).optional(),
  rubro: z.number().int().positive().nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rows = await prisma.entidadInterna.findMany({
    orderBy: { nombreCanonico: "asc" },
    include: {
      rubroLabel: { select: { rubro: true, name: true } },
    },
  });

  return NextResponse.json({
    entidades: rows.map((r) => ({
      id: r.id,
      rutCanonico: r.rutCanonico,
      rutFormatted: formatRut(r.rutCanonico),
      nombreCanonico: r.nombreCanonico,
      aliases: r.aliases,
      rubro: r.rubro,
      rubroLabel: r.rubroLabel?.name ?? null,
      notas: r.notas,
      active: r.active,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos invalidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const rutCanonico = normalizeRut(parsed.data.rut);
  if (rutCanonico.length < 7) {
    return NextResponse.json(
      { error: "RUT invalido" },
      { status: 400 },
    );
  }

  const aliases = dedupeAliases(parsed.data.aliases ?? []);

  try {
    const created = await prisma.entidadInterna.create({
      data: {
        rutCanonico,
        nombreCanonico: parsed.data.nombreCanonico,
        aliases,
        rubro: parsed.data.rubro ?? null,
        notas: parsed.data.notas ?? null,
        active: parsed.data.active ?? true,
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        rutCanonico: created.rutCanonico,
        rutFormatted: formatRut(created.rutCanonico),
        nombreCanonico: created.nombreCanonico,
        aliases: created.aliases,
        rubro: created.rubro,
        notas: created.notas,
        active: created.active,
      },
      { status: 201 },
    );
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return NextResponse.json(
        { error: `Ya existe una entidad con RUT ${formatRut(rutCanonico)}` },
        { status: 409 },
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

/** "773330972" -> "77.333.097-2" (best-effort, sin validar DV). */
function formatRut(canon: string): string {
  if (!canon) return "";
  const body = canon.slice(0, -1);
  const dv = canon.slice(-1);
  const withDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}
