import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * POST /api/consolidados/egresos-terceros/link
 *
 * Vincula (o desvincula) manualmente un movimiento de banco OUT con un gasto
 * operativo (EgresoMovement). El resultado queda MANUAL.
 *
 * Body:
 *   { bankMovementId, egresoMovementId }   → vincular (→ MANUAL)
 *   { bankMovementId, unlink: true }        → desvincular ese OUT
 */
const bodySchema = z.object({
  bankMovementId: z.string().uuid(),
  egresoMovementId: z.string().uuid().optional(),
  unlink: z.boolean().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "conciliar");
  if (deniedPerm) return deniedPerm;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }
  const { bankMovementId, egresoMovementId, unlink } = parsed.data;

  // Desvincular: borrar el link de egreso de ESTE movimiento de banco y dejar
  // su conciliación (si era el único link) en NO_MATCH.
  if (unlink) {
    const link = await prisma.egresoConciliacionLink.findFirst({
      where: { bankMovementId },
      include: { conciliacion: { include: { links: true } } },
    });
    if (!link) return NextResponse.json({ ok: true });
    await prisma.$transaction(async (tx) => {
      await tx.egresoConciliacionLink.delete({ where: { id: link.id } });
      const remaining = link.conciliacion.links.filter((l) => l.id !== link.id);
      if (remaining.length === 0) {
        await tx.egresoConciliacion.update({
          where: { id: link.conciliacionId },
          data: { status: "NO_MATCH", matchType: null, matchedAt: new Date() },
        });
      }
    });
    return NextResponse.json({ ok: true });
  }

  if (!egresoMovementId) {
    return NextResponse.json({ error: "Falta egresoMovementId" }, { status: 400 });
  }

  const [bm, egreso] = await Promise.all([
    prisma.bankMovement.findUnique({
      where: { id: bankMovementId },
      include: { egresoConciliacionLinks: true },
    }),
    prisma.egresoMovement.findUnique({
      where: { id: egresoMovementId },
      include: { conciliacion: { include: { links: true } } },
    }),
  ]);
  if (!bm) return NextResponse.json({ error: "Movimiento de banco no existe" }, { status: 404 });
  if (bm.direction !== "OUT") {
    return NextResponse.json({ error: "Solo se concilian movimientos OUT" }, { status: 400 });
  }
  if (!egreso) return NextResponse.json({ error: "Egreso no existe" }, { status: 404 });

  // El BM no puede estar ya vinculado a otra conciliación de egreso.
  const ownConcId = egreso.conciliacion?.id ?? null;
  const bmOtherLink = bm.egresoConciliacionLinks.find((l) => l.conciliacionId !== ownConcId);
  if (bmOtherLink) {
    return NextResponse.json(
      { error: "Ese movimiento de banco ya está vinculado a otro egreso. Desvinculá primero." },
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx) => {
    // Crear o actualizar la conciliación del egreso → MANUAL, reset de links.
    const conc = egreso.conciliacion
      ? await tx.egresoConciliacion.update({
          where: { id: egreso.conciliacion.id },
          data: { status: "MANUAL", matchType: "MANUAL", matchedAt: new Date() },
        })
      : await tx.egresoConciliacion.create({
          data: { egresoMovementId, status: "MANUAL", matchType: "MANUAL" },
        });
    await tx.egresoConciliacionLink.deleteMany({ where: { conciliacionId: conc.id } });
    await tx.egresoConciliacionLink.create({
      data: { conciliacionId: conc.id, bankMovementId },
    });
  });

  return NextResponse.json({ ok: true });
}
