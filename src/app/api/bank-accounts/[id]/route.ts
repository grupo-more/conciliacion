import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/bank-accounts/[id]
 *
 * Edita propiedades configurables de una BankAccount. Por ahora solo se
 * permite editar:
 *  - accountingRubro: el rubro contable "natural" de la cuenta. Usado en el
 *    asiento OK para matches MANUAL (predomina sobre lo que vino en la API).
 */
const patchSchema = z.object({
  accountingRubro: z.number().int().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 }
    );
  }

  const data: { accountingRubro?: number | null } = {};
  if (parsed.data.accountingRubro !== undefined) {
    data.accountingRubro = parsed.data.accountingRubro;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Sin cambios" }, { status: 400 });
  }

  // Si manda un rubro, validar que exista en RubroLabel
  if (data.accountingRubro !== null && data.accountingRubro !== undefined) {
    const exists = await prisma.rubroLabel.findUnique({
      where: { rubro: data.accountingRubro },
    });
    if (!exists) {
      return NextResponse.json(
        { error: `El rubro ${data.accountingRubro} no existe.` },
        { status: 400 }
      );
    }
  }

  try {
    const updated = await prisma.bankAccount.update({
      where: { id: params.id },
      data,
    });
    return NextResponse.json({
      id: updated.id,
      bankName: updated.bankName,
      accountNumber: updated.accountNumber,
      accountingRubro: updated.accountingRubro,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2025") {
      return NextResponse.json(
        { error: "Cuenta no encontrada" },
        { status: 404 }
      );
    }
    throw e;
  }
}
