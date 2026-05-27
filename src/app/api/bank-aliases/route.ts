import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/bank-aliases
 *
 * Lista todos los alias configurados + las cuentas disponibles +
 * los strings de banco que aparecen en TesoreriaMovement (para
 * detectar los que faltan mapear).
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const [aliases, accounts, bancosFromTesoreria] = await Promise.all([
    prisma.bankAccountAlias.findMany({
      include: {
        account: {
          select: {
            id: true,
            bankCode: true,
            bankName: true,
            accountNumber: true,
            displayNumber: true,
            alias: true,
          },
        },
      },
      orderBy: { bancoString: "asc" },
    }),
    prisma.bankAccount.findMany({
      where: { active: true },
      orderBy: [{ bankCode: "asc" }, { accountNumber: "asc" }],
      select: {
        id: true,
        bankCode: true,
        bankName: true,
        accountNumber: true,
        displayNumber: true,
        alias: true,
        purpose: true,
      },
    }),
    prisma.tesoreriaMovement.findMany({
      where: { banco: { not: null } },
      select: { banco: true },
      distinct: ["banco"],
    }),
  ]);

  const aliasedSet = new Set(aliases.map((a) => a.bancoString));
  const bancos = bancosFromTesoreria
    .map((b) => b.banco!)
    .filter(Boolean)
    .sort();

  const missing = bancos.filter((b) => !aliasedSet.has(b));

  return NextResponse.json({
    aliases: aliases.map((a) => ({
      id: a.id,
      bancoString: a.bancoString,
      accountId: a.accountId,
      account: a.account,
      notes: a.notes,
      updatedAt: a.updatedAt.toISOString(),
    })),
    accounts,
    bancosSeen: bancos,
    missing,
  });
}

/**
 * POST /api/bank-aliases
 * Body: { bancoString: string, accountId: string, notes?: string }
 */
const createSchema = z.object({
  bancoString: z.string().min(1).max(100),
  accountId: z.string().uuid(),
  notes: z.string().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.format() }, { status: 400 });
  }

  // Validar que la cuenta exista
  const acc = await prisma.bankAccount.findUnique({ where: { id: parsed.data.accountId } });
  if (!acc) {
    return NextResponse.json({ error: "Cuenta no existe" }, { status: 404 });
  }

  try {
    const created = await prisma.bankAccountAlias.create({
      data: {
        bancoString: parsed.data.bancoString.trim(),
        accountId: parsed.data.accountId,
        notes: parsed.data.notes?.trim() || null,
      },
    });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: `Ya existe un alias para "${parsed.data.bancoString}"` },
        { status: 409 }
      );
    }
    throw e;
  }
}
