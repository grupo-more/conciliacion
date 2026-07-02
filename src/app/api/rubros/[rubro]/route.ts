import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  isDifference: z.boolean().optional(),
  // Cuenta bancaria enlazada. null explícito = desasignar.
  accountId: z.string().uuid().optional().nullable(),
});

function parseRubroParam(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

export async function PATCH(
  req: Request,
  { params }: { params: { rubro: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rubro = parseRubroParam(params.rubro);
  if (rubro === null) {
    return NextResponse.json({ error: "Rubro invalido" }, { status: 400 });
  }

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos invalidos", detail: parsed.error.issues },
      { status: 400 }
    );
  }

  const data: {
    name?: string;
    description?: string | null;
    isDifference?: boolean;
    accountId?: string | null;
  } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined) {
    data.description = parsed.data.description;
  }
  if (parsed.data.isDifference !== undefined) {
    data.isDifference = parsed.data.isDifference;
  }
  if (parsed.data.accountId !== undefined) {
    data.accountId = parsed.data.accountId;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Sin cambios" },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.rubroLabel.update({
      where: { rubro },
      data,
    });
    return NextResponse.json({
      rubro: updated.rubro,
      name: updated.name,
      description: updated.description,
      isDifference: updated.isDifference,
      accountId: updated.accountId,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json(
        { error: `Rubro ${rubro} no existe` },
        { status: 404 }
      );
    }
    if (code === "P2002") {
      return NextResponse.json(
        { error: "Esa cuenta bancaria ya está asignada a otro rubro." },
        { status: 409 }
      );
    }
    throw e;
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { rubro: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rubro = parseRubroParam(params.rubro);
  if (rubro === null) {
    return NextResponse.json({ error: "Rubro invalido" }, { status: 400 });
  }

  try {
    await prisma.rubroLabel.delete({ where: { rubro } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json(
        { error: `Rubro ${rubro} no existe` },
        { status: 404 }
      );
    }
    throw e;
  }
}
