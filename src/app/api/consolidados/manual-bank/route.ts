import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";
import { normalizeDescription } from "@/lib/cartolas/normalize";

/**
 * POST /api/consolidados/manual-bank
 *
 * Crea un movimiento bancario MANUAL/ficticio (definido a mano) para cuadrar una
 * Tesorería real que la cartola NO capturó, y lo concilia con ella en un paso.
 *
 * El monto del banco = el monto de la Tesorería (así el asiento OK cuadra por
 * construcción). El movimiento nace `manual=true`: se excluye de saldos/listados
 * de cartola y de Reportes — solo existe para darle rumbo a la Tesorería y que
 * deje de estar estancada.
 */
const bodySchema = z.object({
  tesoreriaId: z.string().uuid(),
  accountId: z.string().uuid(),
  postDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  glosa: z.string().trim().min(1).max(300),
  nota: z.string().trim().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const denied = await denyUnless(session, "conciliar");
  if (denied) return denied;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.format() },
      { status: 400 },
    );
  }
  const { tesoreriaId, accountId, glosa, nota } = parsed.data;
  const [y, m, d] = parsed.data.postDate.split("-").map(Number);
  const postDate = new Date(y, m - 1, d, 0, 0, 0, 0);

  const tm = await prisma.tesoreriaMovement.findUnique({
    where: { id: tesoreriaId },
    include: { consolidado: { include: { links: true } } },
  });
  if (!tm) return NextResponse.json({ error: "La Tesorería no existe" }, { status: 404 });

  // Si ya está vinculada a un banco (real o manual), no la pisamos.
  if (tm.consolidado && tm.consolidado.links.length > 0) {
    return NextResponse.json(
      { error: "Esa Tesorería ya está vinculada. Desvinculá primero." },
      { status: 409 },
    );
  }

  const account = await prisma.bankAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) return NextResponse.json({ error: "La cuenta no existe" }, { status: 404 });

  // Banco = Tesorería (cuadra). El signo define la dirección (IN + / OUT −).
  const amount = tm.monto;
  const direction = amount >= 0n ? "IN" : "OUT";

  const bankMovementId = await prisma.$transaction(async (tx) => {
    // Import centinela por cuenta: agrupa los movimientos manuales sin dejar
    // `statementImportId` nulo (no toca el flujo de cartolas reales).
    const stmt = await tx.statementImport.upsert({
      where: { accountId_fileHash: { accountId, fileHash: `MANUAL:${accountId}` } },
      create: {
        accountId,
        parserCode: "MANUAL",
        fileName: "Movimientos manuales",
        fileHash: `MANUAL:${accountId}`,
      },
      update: {},
    });

    const bm = await tx.bankMovement.create({
      data: {
        accountId,
        statementImportId: stmt.id,
        postDate,
        amount,
        currency: "CLP",
        direction,
        description: glosa,
        descriptionNorm: normalizeDescription(glosa),
        dedupKey: `MANUAL:${randomUUID()}`,
        rawRow: { manual: true } as object,
        manual: true,
        manualNota: nota?.trim() || null,
      },
    });

    const consolidado = tm.consolidado
      ? await tx.consolidado.update({
          where: { id: tm.consolidado.id },
          data: {
            status: "MANUAL",
            matchType: "MANUAL",
            resolvedAccountId: accountId,
            matchedAt: new Date(),
          },
        })
      : await tx.consolidado.create({
          data: {
            tesoreriaMovementId: tm.id,
            status: "MANUAL",
            matchType: "MANUAL",
            resolvedAccountId: accountId,
          },
        });

    await tx.consolidadoLink.create({
      data: { consolidadoId: consolidado.id, bankMovementId: bm.id, amountAllocated: null },
    });

    return bm.id;
  });

  return NextResponse.json({ ok: true, bankMovementId });
}
