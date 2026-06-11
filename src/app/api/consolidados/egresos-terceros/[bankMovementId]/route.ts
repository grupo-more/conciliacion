import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { scoreEgresoPair } from "@/lib/egresos/match-terceros";

/**
 * GET /api/consolidados/egresos-terceros/[bankMovementId]
 *
 * Detalle de un movimiento de banco OUT a terceros para conciliarlo contra un
 * gasto operativo (EgresoMovement): el egreso ya vinculado (si existe), los
 * candidatos por monto+fecha con su score, y búsqueda manual por ?q=.
 *
 * El [bankMovementId] es el id del BankMovement.
 */
const DATE_WINDOW_DAYS = 7;

export async function GET(
  req: Request,
  context: { params: { bankMovementId: string } },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const bmId = context.params.bankMovementId;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  const bm = await prisma.bankMovement.findUnique({
    where: { id: bmId },
    include: {
      account: true,
      egresoConciliacionLinks: {
        include: {
          conciliacion: {
            include: { egresoMovement: true },
          },
        },
        take: 1,
      },
      // Conciliación contra Tesorería (módulo principal), si ya existe.
      consolidadoLinks: {
        include: { consolidado: { include: { tesoreriaMovement: true } } },
        take: 1,
      },
    },
  });
  if (!bm) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });

  const absAmt = bm.amount < 0n ? -bm.amount : bm.amount;
  const dayMs = 86400000;
  const lower = new Date(bm.postDate.getTime() - DATE_WINDOW_DAYS * dayMs);
  const upper = new Date(bm.postDate.getTime() + DATE_WINDOW_DAYS * dayMs);

  // Egreso actualmente vinculado a este BM (si lo hay).
  const linkedEgreso = bm.egresoConciliacionLinks[0]?.conciliacion?.egresoMovement ?? null;
  const linkedStatus = bm.egresoConciliacionLinks[0]?.conciliacion?.status ?? null;

  // Tesorería ya conciliada contra este BM (módulo principal), si existe.
  const cLink = bm.consolidadoLinks[0]?.consolidado ?? null;
  const linkedTesoreria =
    cLink && (cLink.status === "AUTO_MATCHED" || cLink.status === "MANUAL")
      ? {
          tesoreriaId: cLink.tesoreriaMovement.id,
          externalId: cLink.tesoreriaMovement.externalId.toString(),
          fecha: cLink.tesoreriaMovement.fecha.toISOString(),
          monto: cLink.tesoreriaMovement.monto.toString(),
          glosa: cLink.tesoreriaMovement.glosa,
          banco: cLink.tesoreriaMovement.banco,
          status: cLink.status,
        }
      : null;

  // Candidatos: egresos del mismo monto (cualquier signo) en ±7d, que NO estén
  // ya vinculados a OTRO movimiento de banco.
  const rawCands = await prisma.egresoMovement.findMany({
    where: {
      monto: { in: [absAmt, -absAmt] },
      fecha: { gte: lower, lte: upper },
    },
    include: { conciliacion: { include: { links: true } } },
    take: 50,
  });
  const candidates = rawCands
    .filter((e) => {
      const links = e.conciliacion?.links ?? [];
      // disponible si no tiene links, o su único link es justamente este BM.
      return links.length === 0 || links.every((l) => l.bankMovementId === bmId);
    })
    .map((e) => {
      const { score, factors } = scoreEgresoPair(e, bm);
      return {
        egresoMovementId: e.id,
        externalId: e.externalId.toString(),
        fecha: e.fecha.toISOString(),
        monto: e.monto.toString(),
        glosa: e.glosa,
        rubroNombre: e.rubroNombre,
        sucursalName: e.sucursalName,
        score,
        factors: factors.map((f) => ({ key: f.key as string, label: f.label, weight: f.weight })),
        alreadyLinkedHere: !!e.conciliacion?.links?.some((l) => l.bankMovementId === bmId),
      };
    })
    .sort((a, b) => b.score - a.score);

  // Búsqueda manual por glosa (cualquier monto/fecha), excluyendo los ya
  // vinculados a otro BM.
  let search: typeof candidates = [];
  if (q) {
    const rawSearch = await prisma.egresoMovement.findMany({
      where: { glosa: { contains: q, mode: "insensitive" } },
      include: { conciliacion: { include: { links: true } } },
      orderBy: { fecha: "desc" },
      take: 50,
    });
    search = rawSearch
      .filter((e) => {
        const links = e.conciliacion?.links ?? [];
        return links.length === 0 || links.every((l) => l.bankMovementId === bmId);
      })
      .map((e) => {
        const { score, factors } = scoreEgresoPair(e, bm);
        return {
          egresoMovementId: e.id,
          externalId: e.externalId.toString(),
          fecha: e.fecha.toISOString(),
          monto: e.monto.toString(),
          glosa: e.glosa,
          rubroNombre: e.rubroNombre,
          sucursalName: e.sucursalName,
          score,
          factors: factors.map((f) => ({ key: f.key as string, label: f.label, weight: f.weight })),
          alreadyLinkedHere: !!e.conciliacion?.links?.some((l) => l.bankMovementId === bmId),
        };
      });
  }

  // Candidatos de la OTRA fuente: movimientos de Tesorería (caja) del mismo
  // monto (signo incluido, para que el match cuadre sin ajuste) en ±7d que NO
  // estén ya conciliados a otra cuenta. Cubre el "porsiacaso busca en la otra
  // API": pagos cross-banco que el motor principal dejó en SUGGESTED porque
  // Tesorería trae un banco pero la plata salió por otro. Permite resolverlos
  // sin salir de la tab. Sólo aplica si el BM no está ya conciliado.
  let tesoreriaCandidates: Array<{
    tesoreriaId: string;
    externalId: string;
    fecha: string;
    monto: string;
    glosa: string;
    banco: string | null;
    bancoDetectado: string | null;
    clienteName: string | null;
    consolidadoStatus: string | null;
    proposedForThis: boolean;
  }> = [];
  if (!linkedEgreso && !linkedTesoreria) {
    const tmsRaw = await prisma.tesoreriaMovement.findMany({
      where: {
        monto: bm.amount,
        fecha: { gte: lower, lte: upper },
        OR: [
          { consolidado: null },
          { consolidado: { status: { in: ["SUGGESTED", "REVIEW", "NO_MATCH", "OUT_OF_SCOPE"] } } },
        ],
      },
      include: { consolidado: { select: { status: true, proposalJson: true } } },
      orderBy: { fecha: "asc" },
      take: 20,
    });
    tesoreriaCandidates = tmsRaw
      .map((t) => {
        const propIds =
          (t.consolidado?.proposalJson as { bankMovementIds?: string[] } | null)?.bankMovementIds ?? [];
        return {
          tesoreriaId: t.id,
          externalId: t.externalId.toString(),
          fecha: t.fecha.toISOString(),
          monto: t.monto.toString(),
          glosa: t.glosa,
          banco: t.banco,
          bancoDetectado: t.bancoDetectado,
          clienteName: t.clienteName,
          consolidadoStatus: t.consolidado?.status ?? null,
          proposedForThis: propIds.includes(bmId),
        };
      })
      // El que el motor ya propuso para este OUT, primero.
      .sort((a, b) => Number(b.proposedForThis) - Number(a.proposedForThis));
  }

  return NextResponse.json({
    bankMovement: {
      id: bm.id,
      postDate: bm.postDate.toISOString(),
      amount: bm.amount.toString(),
      description: bm.description,
      counterpartyName: bm.counterpartyName,
      counterpartyRut: bm.counterpartyRut,
      account: {
        bankName: bm.account.bankName,
        holderName: bm.account.holderName,
        displayNumber: bm.account.displayNumber,
        accountNumber: bm.account.accountNumber,
      },
    },
    linked: linkedEgreso
      ? {
          egresoMovementId: linkedEgreso.id,
          externalId: linkedEgreso.externalId.toString(),
          fecha: linkedEgreso.fecha.toISOString(),
          monto: linkedEgreso.monto.toString(),
          glosa: linkedEgreso.glosa,
          rubroNombre: linkedEgreso.rubroNombre,
          status: linkedStatus,
        }
      : null,
    linkedTesoreria,
    candidates,
    search,
    tesoreriaCandidates,
  });
}
