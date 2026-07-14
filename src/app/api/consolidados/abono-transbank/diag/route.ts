import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";
import { transbankPrismaWhere } from "@/lib/transbank/detect";

/**
 * DIAGNÓSTICO + REPARACIÓN TEMPORAL — /api/consolidados/abono-transbank/diag
 *
 * GET            → diagnóstico read-only: compara los refId consumidos por las
 *                  emisiones contra los BankMovement que existen hoy. refId
 *                  "huérfanos" = los ids cambiaron (borrado + re-import).
 * GET ?apply=1   → REPARA: re-vincula cada emisión con huérfanos a los abonos
 *                  Transbank actuales dentro de su rango [desde,hasta). Solo
 *                  actúa si la CANTIDAD y el TOTAL cuadran exacto (doble guarda);
 *                  si no, omite esa emisión y lo reporta. Conserva el folio y NO
 *                  re-emite nada a gestión.
 *
 * Borrar este archivo cuando terminemos.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const apply = new URL(req.url).searchParams.get("apply") === "1";
  if (apply) {
    const denied = await denyUnless(session, "generarAsientos");
    if (denied) return denied;
    return repair();
  }

  // 1) Emisiones de Abono Transbank + sus consumos (refId = bankMovementId al emitir).
  const emisiones = await prisma.emisionAsientos.findMany({
    where: { origen: "ABONO_TRANSBANK" },
    orderBy: { folio: "asc" },
    select: { id: true, folio: true, desde: true, hasta: true, count: true },
  });
  const consumos = await prisma.emisionConsumo.findMany({
    where: { emision: { origen: "ABONO_TRANSBANK" } },
    select: { refId: true, emisionId: true },
  });
  const consumedIds = consumos.map((c) => c.refId);

  // 2) ¿Cuántos de esos refId todavía existen como BankMovement?
  const existentes =
    consumedIds.length > 0
      ? await prisma.bankMovement.findMany({
          where: { id: { in: consumedIds } },
          select: { id: true },
        })
      : [];
  const existentesSet = new Set(existentes.map((m) => m.id));
  const huerfanos = consumedIds.filter((id) => !existentesSet.has(id));

  // 3) Abonos Transbank actuales (últimos 120 días) y si su id está consumido.
  const desde = new Date();
  desde.setDate(desde.getDate() - 120);
  const movs = await prisma.bankMovement.findMany({
    where: { ...transbankPrismaWhere, descartadoAt: null, postDate: { gte: desde } },
    select: { id: true, postDate: true, amount: true, description: true, accountId: true },
    orderBy: { postDate: "desc" },
    take: 500,
  });
  const consumedSet = new Set(consumedIds);
  const noConsumidos = movs.filter((m) => !consumedSet.has(m.id));

  const veredicto =
    consumedIds.length === 0
      ? "NO hay consumos ABONO_TRANSBANK en la base: las emisiones no consumieron nada (revisar el emitir)."
      : huerfanos.length > 0
        ? `HUÉRFANOS: ${huerfanos.length} de ${consumedIds.length} refId de emisión apuntan a movimientos que YA NO EXISTEN. Los ids cambiaron (borrado + re-import de la cartola) → por eso los actuales no se excluyen.`
        : "Todos los refId consumidos existen. Si igual reaparecen, el problema NO es orfandad — avisar para revisar la exclusión.";

  return NextResponse.json({
    veredicto,
    resumen: {
      emisiones: emisiones.length,
      refIdsConsumidos: consumedIds.length,
      refIdsHuerfanos: huerfanos.length,
      movimientosActuales: movs.length,
      movimientosActualesNoConsumidos: noConsumidos.length,
    },
    emisiones: emisiones.map((e) => ({
      folio: e.folio,
      desde: e.desde.toISOString().slice(0, 10),
      hasta: e.hasta.toISOString().slice(0, 10),
      count: e.count,
      consumos: consumos.filter((c) => c.emisionId === e.id).length,
    })),
    // Muestra de movimientos actuales que NO están consumidos (los que reaparecen).
    ejemplosNoConsumidos: noConsumidos.slice(0, 15).map((m) => ({
      id: m.id,
      fecha: m.postDate.toISOString().slice(0, 10),
      monto: m.amount.toString(),
      glosa: (m.description ?? "").slice(0, 40),
    })),
    // Muestra de refId huérfanos (ids que la emisión recuerda pero ya no existen).
    ejemplosHuerfanos: huerfanos.slice(0, 15),
  });
}

const absBig = (n: bigint) => (n < 0n ? -n : n);

/**
 * Re-vincula las emisiones ABONO_TRANSBANK con referencias huérfanas a los
 * abonos actuales de su rango. Doble guarda (cantidad + total); si no cuadra,
 * omite y reporta. No re-emite: solo corrige a qué ids apunta la emisión.
 */
async function repair() {
  const emisiones = await prisma.emisionAsientos.findMany({
    where: { origen: "ABONO_TRANSBANK" },
    orderBy: { folio: "asc" },
    select: { id: true, folio: true, desde: true, hasta: true, totalBruto: true },
  });
  const consumos = await prisma.emisionConsumo.findMany({
    where: { emision: { origen: "ABONO_TRANSBANK" } },
    select: { id: true, refId: true, emisionId: true },
  });

  const allRefIds = consumos.map((c) => c.refId);
  const existentes =
    allRefIds.length > 0
      ? await prisma.bankMovement.findMany({
          where: { id: { in: allRefIds } },
          select: { id: true },
        })
      : [];
  const existSet = new Set(existentes.map((m) => m.id));
  const consumedSet = new Set(allRefIds); // ids ya tomados por alguna emisión

  const resultados: Array<Record<string, unknown>> = [];

  for (const e of emisiones) {
    const cons = consumos.filter((c) => c.emisionId === e.id);
    const orphaned = cons.filter((c) => !existSet.has(c.refId));
    const existing = cons.filter((c) => existSet.has(c.refId));
    if (orphaned.length === 0) {
      resultados.push({ folio: e.folio, accion: "sin huérfanos" });
      continue;
    }

    // Abonos actuales en el rango de la emisión que NO estén ya consumidos.
    const currentMovs = await prisma.bankMovement.findMany({
      where: {
        ...transbankPrismaWhere,
        descartadoAt: null,
        postDate: { gte: e.desde, lt: e.hasta },
        id: { notIn: Array.from(consumedSet) },
      },
      select: { id: true, amount: true },
    });

    // Guarda 1: la cantidad de actuales sin consumir debe igualar los huérfanos.
    if (currentMovs.length !== orphaned.length) {
      resultados.push({
        folio: e.folio,
        accion: "OMITIDO",
        motivo: `huérfanos=${orphaned.length} pero actuales-sin-consumir-en-rango=${currentMovs.length} (no coinciden; revisar a mano)`,
      });
      continue;
    }

    // Guarda 2: el total (actuales + ya-vinculados) debe igualar el total de la emisión.
    const sumCurrent = currentMovs.reduce((a, m) => a + absBig(m.amount), 0n);
    let sumExisting = 0n;
    if (existing.length > 0) {
      const em = await prisma.bankMovement.findMany({
        where: { id: { in: existing.map((c) => c.refId) } },
        select: { amount: true },
      });
      sumExisting = em.reduce((a, m) => a + absBig(m.amount), 0n);
    }
    if (sumCurrent + sumExisting !== e.totalBruto) {
      resultados.push({
        folio: e.folio,
        accion: "OMITIDO",
        motivo: `el total no cuadra: actuales ${sumCurrent} + ya-ok ${sumExisting} ≠ emisión ${e.totalBruto}`,
      });
      continue;
    }

    // Re-vincular: borrar los consumos huérfanos y crear los nuevos apuntando a
    // los ids actuales. El refId es @unique pero estos ids no están consumidos.
    await prisma.$transaction([
      prisma.emisionConsumo.deleteMany({ where: { id: { in: orphaned.map((o) => o.id) } } }),
      prisma.emisionConsumo.createMany({
        data: currentMovs.map((m) => ({ emisionId: e.id, refId: m.id })),
      }),
    ]);
    for (const m of currentMovs) consumedSet.add(m.id);
    resultados.push({ folio: e.folio, accion: "RE-VINCULADO", reVinculados: currentMovs.length });
  }

  return NextResponse.json({ ok: true, resultados });
}
