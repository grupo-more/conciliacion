import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * Movimientos descartados: movimientos de cartola que no corresponden al
 * sistema y no deben conciliar ni contar como pendientes en ninguna vista.
 *
 * POST   → envía uno o varios movimientos a descartados. Bloquea los que ya
 *          tienen un vínculo de conciliación (hay que desvincular primero).
 * DELETE → restaura (saca de descartados) uno o varios movimientos.
 *
 * No se borra la fila: se marca `descartadoAt` y se registra el descarte de
 * forma durable en MovimientoDescartado por (accountId, dedupKey), de modo que
 * el re-import de la cartola no lo reinserte aunque la fila llegara a borrarse.
 */

const bodySchema = z.object({
  movementIds: z.array(z.string().uuid()).min(1).max(1000),
  razon: z.string().trim().max(500).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { movementIds, razon } = parsed.data;

  const movements = await prisma.bankMovement.findMany({
    where: { id: { in: movementIds } },
    select: {
      id: true,
      accountId: true,
      dedupKey: true,
      descartadoAt: true,
      asientoManual: { select: { id: true } },
      _count: { select: { consolidadoLinks: true, egresoConciliacionLinks: true } },
    },
  });

  // Un movimiento está "resuelto" si tiene link del motor, link de egreso a
  // tercero o un asiento manual generado. Esos se bloquean: hay que deshacer
  // primero. El resto (sin vínculos y no descartado aún) se puede descartar.
  const resuelto = (m: (typeof movements)[number]) =>
    m._count.consolidadoLinks > 0 ||
    m._count.egresoConciliacionLinks > 0 ||
    m.asientoManual != null;
  const bloqueados = movements.filter(resuelto);
  const aDescartar = movements.filter((m) => !resuelto(m) && !m.descartadoAt);

  const now = new Date();
  let descartados = 0;
  if (aDescartar.length > 0) {
    await prisma.$transaction([
      prisma.bankMovement.updateMany({
        where: { id: { in: aDescartar.map((m) => m.id) } },
        data: { descartadoAt: now },
      }),
      // Registro durable por (accountId, dedupKey). Upsert-por-lote no existe,
      // así que hacemos createMany con skipDuplicates (el par ya único no re-crea).
      prisma.movimientoDescartado.createMany({
        data: aDescartar.map((m) => ({
          accountId: m.accountId,
          dedupKey: m.dedupKey,
          razon: razon ?? null,
          descartadoById: session.sub,
        })),
        skipDuplicates: true,
      }),
    ]);
    descartados = aDescartar.length;
  }

  return NextResponse.json({
    descartados,
    bloqueados: bloqueados.map((m) => m.id),
    yaDescartados: movements.filter((m) => m.descartadoAt).map((m) => m.id),
    mensaje:
      bloqueados.length > 0
        ? `${descartados} descartado(s). ${bloqueados.length} no se descartaron porque ya están conciliados: desvinculá primero.`
        : `${descartados} movimiento(s) enviado(s) a descartados.`,
  });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { movementIds } = parsed.data;

  const movements = await prisma.bankMovement.findMany({
    where: { id: { in: movementIds }, descartadoAt: { not: null } },
    select: { accountId: true, dedupKey: true },
  });

  await prisma.$transaction([
    prisma.bankMovement.updateMany({
      where: { id: { in: movementIds } },
      data: { descartadoAt: null },
    }),
    ...(movements.length > 0
      ? [
          prisma.movimientoDescartado.deleteMany({
            where: {
              OR: movements.map((m) => ({ accountId: m.accountId, dedupKey: m.dedupKey })),
            },
          }),
        ]
      : []),
  ]);

  return NextResponse.json({ restaurados: movements.length });
}
