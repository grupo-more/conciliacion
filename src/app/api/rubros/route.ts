import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

const createSchema = z.object({
  rubro: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rows = await prisma.rubroLabel.findMany({
    orderBy: { rubro: "asc" },
  });

  return NextResponse.json({
    rubros: rows.map((r) => ({
      rubro: r.rubro,
      name: r.name,
      description: r.description,
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

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos invalidos", detail: parsed.error.issues },
      { status: 400 }
    );
  }

  const { rubro, name, description } = parsed.data;

  const existing = await prisma.rubroLabel.findUnique({ where: { rubro } });
  if (existing) {
    return NextResponse.json(
      { error: `El rubro ${rubro} ya existe` },
      { status: 409 }
    );
  }

  const created = await prisma.rubroLabel.create({
    data: {
      rubro,
      name,
      description: description ?? null,
    },
  });

  return NextResponse.json(
    {
      rubro: created.rubro,
      name: created.name,
      description: created.description,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    },
    { status: 201 }
  );
}
