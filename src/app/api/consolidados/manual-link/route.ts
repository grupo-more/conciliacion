import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/consolidados/manual-link
 *
 * Crea un vinculo manual entre un TesoreriaMovement y uno o varios
 * BankMovements. El monto total de los BMs debe coincidir con el de
 * Tesoreria (validacion server-side).
 *
 * Body: { tesoreriaId: string, bankMovementIds: string[] }
 *
 * Genera/actualiza Consolidado con status=MANUAL. Si el Tesoreria ya
 * tenia un Consolidado, se reemplaza limpiamente (borra links viejos).
 */
const bodySchema = z.object({
  tesoreriaId: z.string().uuid(),
  bankMovementIds: z.array(z.string().uuid()).min(1).max(10),
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

  const { tesoreriaId, bankMovementIds } = parsed.data;

  // Validar Tesoreria
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

  // Validar BankMovements
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

  // Validar que no esten ya en otro Consolidado distinto del que estamos editando
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

  // Validar suma de montos = monto Tesoreria
  const sum = bms.reduce((acc, bm) => acc + bm.amount, 0n);
  if (sum !== t.monto) {
    return NextResponse.json(
      {
        error: `La suma de los movimientos bancarios (${sum.toString()}) no coincide con el monto de Tesorería (${t.monto.toString()}).`,
      },
      { status: 400 }
    );
  }

  // Aplicar en transaccion
  await prisma.$transaction(async (tx) => {
    // Si ya existia un Consolidado, limpiar sus links
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
            matchedAt: new Date(),
          },
        })
      : await tx.consolidado.create({
          data: {
            tesoreriaMovementId: tesoreriaId,
            status: "MANUAL",
            matchType,
            resolvedAccountId: accountId,
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
