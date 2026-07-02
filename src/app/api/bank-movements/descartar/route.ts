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
      description: true,
      postDate: true,
      asientoManual: { select: { id: true } },
      _count: { select: { consolidadoLinks: true, egresoConciliacionLinks: true } },
    },
  });

  // Movimientos matcheados por la conciliación de caja (MovimientoCaja). No es
  // un ConsolidadoLink, es una referencia suelta por bankMovementId, así que se
  // consulta aparte. Si está matcheado, también está "resuelto".
  const cajaMatched = await prisma.movimientoCaja.findMany({
    where: { bankMovementId: { in: movementIds }, status: { in: ["AUTO_MATCHED", "MANUAL"] } },
    select: { bankMovementId: true },
  });
  const cajaMatchedSet = new Set(cajaMatched.map((c) => c.bankMovementId));

  // Motivos que BLOQUEAN el descarte: solo conciliaciones contables DELIBERADAS
  // (motor, egreso a tercero, asiento manual). Esas hay que deshacerlas primero.
  // El match de conciliación de CAJA NO bloquea: es un match automático/heurístico
  // (monto+fecha+cuenta) sin UI para deshacerse; al descartar se rompe solo (el
  // MovimientoCaja vuelve a NO_MATCH). Ver más abajo.
  const motivosDe = (m: (typeof movements)[number]): string[] => {
    const ms: string[] = [];
    if (m._count.consolidadoLinks > 0) ms.push("vínculo del motor (Consolidados)");
    if (m._count.egresoConciliacionLinks > 0) ms.push("conciliación de egreso a tercero");
    if (m.asientoManual != null) ms.push("asiento manual generado");
    return ms;
  };
  const bloqueados = movements
    .map((m) => ({ m, motivos: motivosDe(m) }))
    .filter((x) => x.motivos.length > 0);
  const bloqueadoIds = new Set(bloqueados.map((x) => x.m.id));
  const aDescartar = movements.filter((m) => !bloqueadoIds.has(m.id) && !m.descartadoAt);

  // De los que se van a descartar, cuáles tenían un match de caja → hay que
  // romperlo (dejar el MovimientoCaja en NO_MATCH) para no dejarlo apuntando a
  // un movimiento descartado.
  const descartarIds = aDescartar.map((m) => m.id);
  const cajaAromper = descartarIds.filter((id) => cajaMatchedSet.has(id));

  const now = new Date();
  let descartados = 0;
  let cajaRotos = 0;
  if (aDescartar.length > 0) {
    await prisma.$transaction([
      prisma.bankMovement.updateMany({
        where: { id: { in: descartarIds } },
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
      // Romper matches de caja de los movimientos descartados.
      prisma.movimientoCaja.updateMany({
        where: { bankMovementId: { in: cajaAromper } },
        data: { status: "NO_MATCH", bankMovementId: null, matchType: null, score: null },
      }),
    ]);
    descartados = aDescartar.length;
    cajaRotos = cajaAromper.length;
  }

  // Detalle legible de los bloqueados: fecha + glosa + motivo(s).
  const detalleBloqueados = bloqueados.map((x) => ({
    id: x.m.id,
    fecha: x.m.postDate.toISOString().slice(0, 10),
    glosa: x.m.description,
    motivos: x.motivos,
  }));

  const cajaNota =
    cajaRotos > 0 ? ` (${cajaRotos} match de caja roto[s] y devuelto[s] a NO_MATCH)` : "";
  let mensaje: string;
  if (bloqueados.length === 0) {
    mensaje = `${descartados} movimiento(s) enviado(s) a descartados${cajaNota}.`;
  } else {
    const lineas = detalleBloqueados
      .map((d) => `• ${d.fecha} · ${d.glosa} → ${d.motivos.join(" + ")}`)
      .join("\n");
    mensaje =
      `${descartados} descartado(s)${cajaNota}. ${bloqueados.length} bloqueado(s) porque tienen una ` +
      `conciliación contable activa (hay que deshacerla primero):\n${lineas}`;
  }

  return NextResponse.json({
    descartados,
    bloqueados: detalleBloqueados,
    yaDescartados: movements.filter((m) => m.descartadoAt).map((m) => m.id),
    mensaje,
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
