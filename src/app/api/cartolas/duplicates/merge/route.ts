import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/cartolas/duplicates/merge
 *
 * Fusiona un grupo de movimientos bancarios duplicados. El usuario elige
 * cuál se queda (`keepId`) y el resto se elimina. Si alguno de los
 * eliminados tenía un ConsolidadoLink, se re-vincula al que se queda
 * (siempre que el que se queda no tuviera ya su propio link a otro
 * Consolidado distinto).
 *
 * Body: { keepId: string, removeIds: string[] }
 *
 * Reglas de seguridad:
 *   - Todos los movimientos deben pertenecer a la misma cuenta y mismo monto
 *     (sanity check, evita merges accidentales).
 *   - Si dos movs distintos tienen links a Consolidados distintos, se rechaza
 *     (caso ambiguo, requiere intervención manual).
 */
const bodySchema = z.object({
  keepId: z.string().uuid(),
  removeIds: z.array(z.string().uuid()).min(1).max(10),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.format() },
      { status: 400 }
    );
  }

  const { keepId, removeIds } = parsed.data;
  if (removeIds.includes(keepId)) {
    return NextResponse.json(
      { error: "keepId no puede estar en removeIds" },
      { status: 400 }
    );
  }

  const allIds = [keepId, ...removeIds];
  const movements = await prisma.bankMovement.findMany({
    where: { id: { in: allIds } },
    include: { consolidadoLinks: true },
  });
  if (movements.length !== allIds.length) {
    return NextResponse.json(
      { error: "Uno o más movimientos no existen" },
      { status: 404 }
    );
  }

  // Sanity: misma cuenta y mismo monto
  const accountIds = new Set(movements.map((m) => m.accountId));
  const amounts = new Set(movements.map((m) => m.amount.toString()));
  if (accountIds.size !== 1 || amounts.size !== 1) {
    return NextResponse.json(
      {
        error:
          "Los movimientos deben ser de la misma cuenta y mismo monto. Revisá la selección.",
      },
      { status: 400 }
    );
  }

  const keep = movements.find((m) => m.id === keepId)!;
  const removed = movements.filter((m) => m.id !== keepId);

  // Detectar conflictos de Consolidado
  const keepConsolidadoIds = new Set(
    keep.consolidadoLinks.map((l) => l.consolidadoId)
  );
  const consolidadosFromRemoved = new Set<string>();
  for (const r of removed) {
    for (const l of r.consolidadoLinks) {
      consolidadosFromRemoved.add(l.consolidadoId);
    }
  }
  // Ambigüedad: keep está linkeado a A, alguien removed está linkeado a B distinto.
  if (keepConsolidadoIds.size > 0) {
    for (const cid of consolidadosFromRemoved) {
      if (!keepConsolidadoIds.has(cid)) {
        return NextResponse.json(
          {
            error:
              "Conflicto: el movimiento que querés conservar ya está vinculado a un Consolidado distinto al de los que querés eliminar. Resolvé el conflicto manualmente desde Consolidados.",
          },
          { status: 409 }
        );
      }
    }
  }

  // Aplicar
  await prisma.$transaction(async (tx) => {
    // Si el `keep` no tiene link pero algún `removed` sí, transferirlo al keep.
    if (keepConsolidadoIds.size === 0 && consolidadosFromRemoved.size > 0) {
      // Tomar el primer link transferible (todos apuntan al mismo Consolidado
      // por la validacion previa, o no hay nada que transferir).
      // Borrar todos los links de los removidos y crear UNO nuevo apuntando al keep.
      const targetConsolidadoId = Array.from(consolidadosFromRemoved)[0];
      await tx.consolidadoLink.deleteMany({
        where: { bankMovementId: { in: removed.map((r) => r.id) } },
      });
      await tx.consolidadoLink.create({
        data: {
          consolidadoId: targetConsolidadoId,
          bankMovementId: keepId,
        },
      });
    } else {
      // Solo borrar links de los removidos
      await tx.consolidadoLink.deleteMany({
        where: { bankMovementId: { in: removed.map((r) => r.id) } },
      });
    }

    // Borrar los movimientos removidos
    await tx.bankMovement.deleteMany({
      where: { id: { in: removed.map((r) => r.id) } },
    });
  });

  return NextResponse.json({
    ok: true,
    kept: keepId,
    removed: removed.length,
    transferredConsolidadoLink: keepConsolidadoIds.size === 0 && consolidadosFromRemoved.size > 0,
  });
}
