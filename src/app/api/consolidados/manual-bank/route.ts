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
 * Crea UN movimiento bancario MANUAL/ficticio (definido a mano) para cuadrar una
 * o VARIAS Tesorerías reales que la cartola NO capturó, y las concilia en un paso.
 *
 * El monto del banco = la SUMA de las Tesorerías (así cuadra por construcción).
 * Con varias tesorerías se crea 1 banco y N Consolidados, y cada link lleva su
 * `amountAllocated` = el monto de esa tesorería (anidado). El movimiento nace
 * `manual=true`: se excluye de saldos/listados de cartola y de Reportes — solo
 * existe para darle rumbo a las Tesorerías y que dejen de estar estancadas.
 */
const bodySchema = z.object({
  tesoreriaIds: z.array(z.string().uuid()).min(1).max(200),
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
  const { accountId, glosa, nota } = parsed.data;
  const tesoreriaIds = Array.from(new Set(parsed.data.tesoreriaIds));
  const [y, m, d] = parsed.data.postDate.split("-").map(Number);
  const postDate = new Date(y, m - 1, d, 0, 0, 0, 0);

  const tms = await prisma.tesoreriaMovement.findMany({
    where: { id: { in: tesoreriaIds } },
    include: { consolidado: { include: { links: true } } },
  });
  if (tms.length !== tesoreriaIds.length) {
    return NextResponse.json({ error: "Una o más Tesorerías no existen" }, { status: 404 });
  }

  // Ninguna puede estar ya vinculada a un banco.
  const yaVinculada = tms.find((t) => t.consolidado && t.consolidado.links.length > 0);
  if (yaVinculada) {
    return NextResponse.json(
      { error: "Una de las Tesorerías ya está vinculada. Desvinculá primero." },
      { status: 409 },
    );
  }

  const account = await prisma.bankAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  });
  if (!account) return NextResponse.json({ error: "La cuenta no existe" }, { status: 404 });

  // Banco = Σ Tesorerías (cuadra). El signo define la dirección (IN + / OUT −).
  const amount = tms.reduce((acc, t) => acc + t.monto, 0n);
  const direction = amount >= 0n ? "IN" : "OUT";
  const isMulti = tms.length > 1;

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

    // Un Consolidado por Tesorería; el banco manual se reparte entre ellas
    // (cada link lleva el monto de su tesorería). Con 1 sola, allocated=null.
    for (const t of tms) {
      const consolidado = t.consolidado
        ? await tx.consolidado.update({
            where: { id: t.consolidado.id },
            data: {
              status: "MANUAL",
              matchType: isMulti ? "SPLIT_INVERSE_MANUAL" : "MANUAL",
              resolvedAccountId: accountId,
              matchedAt: new Date(),
            },
          })
        : await tx.consolidado.create({
            data: {
              tesoreriaMovementId: t.id,
              status: "MANUAL",
              matchType: isMulti ? "SPLIT_INVERSE_MANUAL" : "MANUAL",
              resolvedAccountId: accountId,
            },
          });

      await tx.consolidadoLink.create({
        data: {
          consolidadoId: consolidado.id,
          bankMovementId: bm.id,
          amountAllocated: isMulti ? t.monto : null,
        },
      });
    }

    return bm.id;
  });

  return NextResponse.json({ ok: true, bankMovementId });
}
