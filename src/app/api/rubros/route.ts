import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

const createSchema = z.object({
  rubro: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  isDifference: z.boolean().optional(),
  // Cuenta bancaria (de Cartolas) enlazada a este rubro. null = sin enlace.
  accountId: z.string().uuid().optional().nullable(),
  // Sucursal (del maestro) enlazada a este rubro. null = sin enlace.
  sucursalId: z.string().uuid().optional().nullable(),
});

/** Etiqueta legible de una cuenta bancaria. */
function accountLabel(a: {
  bankName: string;
  holderName: string;
  displayNumber: string | null;
  accountNumber: string;
}): string {
  return `${a.bankName} ${a.holderName} · ${a.displayNumber || a.accountNumber}`;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rows = await prisma.rubroLabel.findMany({
    orderBy: { rubro: "asc" },
    include: {
      account: {
        select: { id: true, bankName: true, holderName: true, displayNumber: true, accountNumber: true },
      },
      sucursal: { select: { id: true, codigo: true, nombre: true } },
    },
  });

  return NextResponse.json({
    rubros: rows.map((r) => ({
      rubro: r.rubro,
      name: r.name,
      description: r.description,
      isDifference: r.isDifference,
      accountId: r.accountId,
      accountLabel: r.account ? accountLabel(r.account) : null,
      sucursalId: r.sucursalId,
      sucursalLabel: r.sucursal
        ? `${r.sucursal.codigo != null ? r.sucursal.codigo + " · " : ""}${r.sucursal.nombre}`
        : null,
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
      { status: 400 }
    );
  }

  const { rubro, name, description, isDifference, accountId, sucursalId } = parsed.data;

  const existing = await prisma.rubroLabel.findUnique({ where: { rubro } });
  if (existing) {
    return NextResponse.json(
      { error: `El rubro ${rubro} ya existe` },
      { status: 409 }
    );
  }

  try {
    const created = await prisma.rubroLabel.create({
      data: {
        rubro,
        name,
        description: description ?? null,
        isDifference: isDifference ?? false,
        accountId: accountId ?? null,
        sucursalId: sucursalId ?? null,
      },
    });

    return NextResponse.json(
      {
        rubro: created.rubro,
        name: created.name,
        description: created.description,
        isDifference: created.isDifference,
        accountId: created.accountId,
        sucursalId: created.sucursalId,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "Esa cuenta o sucursal ya está asignada a otro rubro." },
        { status: 409 }
      );
    }
    throw e;
  }
}
