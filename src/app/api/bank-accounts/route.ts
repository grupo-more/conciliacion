import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isUnassignedAccountNumber } from "@/lib/cartolas/import";
import { normalizeRut } from "@/lib/internos/detect";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const accounts = await prisma.bankAccount.findMany({
    where: { active: true },
    orderBy: [
      // Las "Sin asignar" al final
      { accountNumber: "asc" },
      { bankName: "asc" },
    ],
  });

  // Conteo de movimientos por cuenta (para badges)
  const counts = await prisma.bankMovement.groupBy({
    by: ["accountId"],
    // Los descartados no cuentan: la lista de Cartolas también los excluye,
    // así el número del sidebar cuadra con lo que se ve.
    where: { descartadoAt: null },
    _count: { _all: true },
  });
  const countByAccount = new Map(counts.map((c) => [c.accountId, c._count._all]));

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      bankCode: a.bankCode,
      bankName: a.bankName,
      accountNumber: a.accountNumber,
      displayNumber: a.displayNumber,
      holderName: a.holderName,
      holderRut: a.holderRut,
      currency: a.currency,
      alias: a.alias,
      purpose: a.purpose,
      isUnassigned: isUnassignedAccountNumber(a.accountNumber),
      movementCount: countByAccount.get(a.id) ?? 0,
    })),
  });
}

const createSchema = z.object({
  bankCode: z.string().trim().min(1),
  bankName: z.string().trim().min(1),
  accountNumber: z.string().trim().min(1),
  displayNumber: z.string().trim().optional().nullable(),
  holderName: z.string().trim().min(1),
  holderRut: z.string().trim().optional().nullable(),
  alias: z.string().trim().optional().nullable(),
  currency: z.string().trim().optional(),
});

/**
 * POST /api/bank-accounts — crea una cuenta bancaria nueva.
 * Se usa desde el ImportModal cuando el usuario decide registrar la cuenta
 * detectada en una cartola en lugar de dejarla en "Sin asignar". El holderRut
 * se normaliza al guardar para que el matcher de Traspasos internos lo
 * encuentre sin problemas.
 */
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
      { status: 400 },
    );
  }

  const d = parsed.data;
  const holderRutNorm = d.holderRut ? normalizeRut(d.holderRut) : "";

  try {
    const created = await prisma.bankAccount.create({
      data: {
        bankCode: d.bankCode,
        bankName: d.bankName,
        accountNumber: d.accountNumber,
        displayNumber: d.displayNumber ?? null,
        holderName: d.holderName,
        holderRut: holderRutNorm || null,
        alias: d.alias ?? null,
        currency: d.currency ?? "CLP",
        active: true,
      },
    });
    return NextResponse.json(
      {
        id: created.id,
        bankCode: created.bankCode,
        bankName: created.bankName,
        accountNumber: created.accountNumber,
        displayNumber: created.displayNumber,
        holderName: created.holderName,
        holderRut: created.holderRut,
        currency: created.currency,
        alias: created.alias,
        purpose: created.purpose,
        isUnassigned: isUnassignedAccountNumber(created.accountNumber),
        movementCount: 0,
      },
      { status: 201 },
    );
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: `Ya existe una cuenta ${d.bankName} con número ${d.accountNumber}`,
        },
        { status: 409 },
      );
    }
    throw e;
  }
}
