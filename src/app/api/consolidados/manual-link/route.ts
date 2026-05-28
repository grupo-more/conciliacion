import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/consolidados/manual-link
 *
 * Crea un vinculo manual entre un TesoreriaMovement y uno o varios
 * BankMovements.
 *
 * Si NO se pasa `adjustment`, la suma de los BMs debe coincidir exacto con
 * el monto de Tesorería (comportamiento histórico).
 *
 * Si se pasa `adjustment`, la diferencia |sum(bms) - t.monto| debe coincidir
 * EXACTAMENTE con adjustment.amount, y el rubro indicado debe existir y estar
 * marcado como `isDifference=true`. El asiento OK desdobla la diferencia
 * como 3ra fila.
 *
 * Body: {
 *   tesoreriaId: string,
 *   bankMovementIds: string[],
 *   adjustment?: { rubro: number, note?: string }
 * }
 */
const bodySchema = z.object({
  tesoreriaId: z.string().uuid(),
  bankMovementIds: z.array(z.string().uuid()).min(1).max(10),
  adjustment: z
    .object({
      rubro: z.number().int(),
      note: z.string().max(500).optional().nullable(),
    })
    .optional()
    .nullable(),
  /** Override del rubro banco para este consolidado (opcional). Si se pasa,
   *  predomina sobre BankAccount.accountingRubro y TesoreriaMovement.rubroBanco
   *  en el asiento OK. */
  overrideRubroBanco: z.number().int().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.format() },
      { status: 400 }
    );
  }

  const { tesoreriaId, bankMovementIds, adjustment, overrideRubroBanco } =
    parsed.data;

  const t = await prisma.tesoreriaMovement.findUnique({
    where: { id: tesoreriaId },
    include: { consolidado: true },
  });
  if (!t) {
    return NextResponse.json(
      { error: "Tesorería no encontrada" },
      { status: 404 }
    );
  }

  const bms = await prisma.bankMovement.findMany({
    where: { id: { in: bankMovementIds } },
    include: { consolidadoLinks: { select: { consolidadoId: true } } },
  });
  if (bms.length !== bankMovementIds.length) {
    return NextResponse.json(
      { error: "Uno o más BankMovements no existen" },
      { status: 404 }
    );
  }

  const myConsolidadoId = t.consolidado?.id ?? null;
  for (const bm of bms) {
    for (const link of bm.consolidadoLinks) {
      if (link.consolidadoId !== myConsolidadoId) {
        return NextResponse.json(
          {
            error: `El BankMovement ${bm.id.slice(0, 8)} ya está vinculado a otro consolidado. Desvinculá ese primero.`,
          },
          { status: 409 }
        );
      }
    }
  }

  // Diferencia entre banco y tesorería (magnitud absoluta)
  const sum = bms.reduce((acc, bm) => acc + bm.amount, 0n);
  const diff = sum - t.monto;
  const absDiff = diff < 0n ? -diff : diff;

  // Validaciones según haya o no ajuste
  let adjustmentAmount: bigint | null = null;
  let adjustmentRubro: number | null = null;
  let adjustmentNote: string | null = null;

  if (adjustment) {
    if (absDiff === 0n) {
      return NextResponse.json(
        {
          error:
            "Se especificó un ajuste pero los montos coinciden. Quitá el ajuste y volvé a intentar.",
        },
        { status: 400 }
      );
    }
    const rubro = await prisma.rubroLabel.findUnique({
      where: { rubro: adjustment.rubro },
    });
    if (!rubro) {
      return NextResponse.json(
        { error: `El rubro ${adjustment.rubro} no existe.` },
        { status: 400 }
      );
    }
    if (!rubro.isDifference) {
      return NextResponse.json(
        {
          error: `El rubro ${adjustment.rubro} (${rubro.name}) no está marcado para usarse en diferencias. Activá la opción en Configuración → Rubros.`,
        },
        { status: 400 }
      );
    }
    adjustmentAmount = absDiff;
    adjustmentRubro = adjustment.rubro;
    adjustmentNote = adjustment.note?.trim() || null;
  } else if (sum !== t.monto) {
    return NextResponse.json(
      {
        error: `La suma de los movimientos bancarios (${sum.toString()}) no coincide con el monto de Tesorería (${t.monto.toString()}). Si la diferencia es esperada, agregá un ajuste.`,
      },
      { status: 400 }
    );
  }

  // Validar overrideRubroBanco si vino
  if (overrideRubroBanco !== undefined && overrideRubroBanco !== null) {
    const rubro = await prisma.rubroLabel.findUnique({
      where: { rubro: overrideRubroBanco },
    });
    if (!rubro) {
      return NextResponse.json(
        { error: `El rubro ${overrideRubroBanco} no existe.` },
        { status: 400 }
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (t.consolidado) {
      await tx.consolidadoLink.deleteMany({
        where: { consolidadoId: t.consolidado.id },
      });
    }

    const accountId = bms[0].accountId;
    const matchType: string =
      bankMovementIds.length === 1 ? "MANUAL" : "SPLIT_SAME_DAY";

    const consolidado = t.consolidado
      ? await tx.consolidado.update({
          where: { id: t.consolidado.id },
          data: {
            status: "MANUAL",
            matchType,
            resolvedAccountId: accountId,
            adjustmentAmount,
            adjustmentRubro,
            adjustmentNote,
            overrideRubroBanco: overrideRubroBanco ?? null,
            matchedAt: new Date(),
          },
        })
      : await tx.consolidado.create({
          data: {
            tesoreriaMovementId: tesoreriaId,
            status: "MANUAL",
            matchType,
            resolvedAccountId: accountId,
            adjustmentAmount,
            adjustmentRubro,
            adjustmentNote,
            overrideRubroBanco: overrideRubroBanco ?? null,
          },
        });

    await tx.consolidadoLink.createMany({
      data: bankMovementIds.map((bmId) => ({
        consolidadoId: consolidado.id,
        bankMovementId: bmId,
      })),
      skipDuplicates: true,
    });
  });

  return NextResponse.json({ ok: true });
}
