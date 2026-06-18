import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/consolidados/egresos-terceros/[bankMovementId]?q=<texto>
 *
 * Detalle de un movimiento de banco OUT a terceros para conciliarlo contra un
 * EGRESO de Dynatech (TesoreriaMovement). La vinculación se hace contra
 * Tesorería (módulo principal) vía /api/consolidados/manual-link.
 *
 * Devuelve:
 *   - el EGRESO de dynatech ya conciliado contra este OUT (si existe),
 *   - candidatos: EGRESO de dynatech del MISMO monto (con signo, así el link
 *     cuadra sin ajuste) en ±7 días, no conciliados a otra cuenta,
 *   - búsqueda manual por ?q= (mismo monto, cualquier fecha) sobre glosa /
 *     cliente / RUT de los EGRESO de dynatech.
 *
 * NOTA: el feed /api/egresos (EgresoMovement, gastos operativos) NO se usa acá
 * — es para un desarrollo futuro. Esta tab concilia OUT ↔ EGRESO de dynatech.
 *
 * El [bankMovementId] es el id del BankMovement.
 */
const DATE_WINDOW_DAYS = 7;

// Estados de un EGRESO de dynatech que NO bloquean proponerlo acá (no tiene un
// link real AUTO/MANUAL contra otra cuenta).
const UNRESOLVED_STATUSES = ["SUGGESTED", "REVIEW", "NO_MATCH", "OUT_OF_SCOPE", "ANULADO"] as const;

interface TesoreriaCand {
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
}

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
      // Vínculo legacy contra un gasto operativo (EgresoMovement), si quedó de antes.
      egresoConciliacionLinks: {
        include: { conciliacion: { include: { egresoMovement: true } } },
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

  const dayMs = 86400000;
  const lower = new Date(bm.postDate.getTime() - DATE_WINDOW_DAYS * dayMs);
  const upper = new Date(bm.postDate.getTime() + DATE_WINDOW_DAYS * dayMs);

  // Egreso operativo legacy vinculado a este BM (si lo hay). Solo para poder
  // deshacer vínculos viejos — no se proponen nuevos.
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

  // Excluyente: no proponer candidatos si el OUT ya está conciliado por algún lado.
  const alreadyResolved = !!linkedEgreso || !!linkedTesoreria;

  // Filtro común: EGRESO de dynatech, mismo monto (con signo, para que el link
  // cuadre exacto en manual-link), no enganchado a otra cuenta con link real.
  const unresolvedClause = {
    OR: [
      { consolidado: null },
      { consolidado: { status: { in: [...UNRESOLVED_STATUSES] } } },
    ],
  };

  const mapTm = (t: {
    id: string; externalId: bigint; fecha: Date; monto: bigint; glosa: string;
    banco: string | null; bancoDetectado: string | null; clienteName: string | null;
    consolidado: { status: string; proposalJson: unknown } | null;
  }): TesoreriaCand => {
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
  };

  // Candidatos por monto + ventana de fecha.
  let tesoreriaCandidates: TesoreriaCand[] = [];
  if (!alreadyResolved) {
    const rows = await prisma.tesoreriaMovement.findMany({
      where: {
        tipoOperacion: "EGRESO",
        monto: bm.amount,
        fecha: { gte: lower, lte: upper },
        ...unresolvedClause,
      },
      include: { consolidado: { select: { status: true, proposalJson: true } } },
      orderBy: { fecha: "asc" },
      take: 30,
    });
    tesoreriaCandidates = rows
      .map(mapTm)
      .sort((a, b) => Number(b.proposedForThis) - Number(a.proposedForThis));
  }

  // Búsqueda manual: mismo monto (link cuadra), CUALQUIER fecha, filtrando por
  // texto en glosa / cliente / RUT. Permite hallar el egreso fuera de la ventana.
  let tesoreriaSearch: TesoreriaCand[] = [];
  if (!alreadyResolved && q) {
    const rows = await prisma.tesoreriaMovement.findMany({
      where: {
        tipoOperacion: "EGRESO",
        monto: bm.amount,
        AND: [
          unresolvedClause,
          {
            OR: [
              { glosa: { contains: q, mode: "insensitive" } },
              { clienteName: { contains: q, mode: "insensitive" } },
              { clienteRut: { contains: q, mode: "insensitive" } },
            ],
          },
        ],
      },
      include: { consolidado: { select: { status: true, proposalJson: true } } },
      orderBy: { fecha: "desc" },
      take: 50,
    });
    tesoreriaSearch = rows.map(mapTm);
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
    tesoreriaCandidates,
    tesoreriaSearch,
  });
}
