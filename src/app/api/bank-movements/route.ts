import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { isTransbank } from "@/lib/transbank/detect";
import { getDifMenorSettings, isDifMenor, isComisionBancaria } from "@/lib/dif-menor/detect";
import {
  isUsoParcialAccount,
  usoParcialAccountWhere,
  USO_PARCIAL_SQL,
} from "@/lib/cuentas/uso-parcial";
import { consumedRefIds } from "@/lib/consolidados/emision-consumo";

/**
 * GET /api/bank-movements
 *
 * Lista de movimientos bancarios filtrados. Por cada movimiento devuelve
 * tambien el estado de conciliacion (`consolidado`) para que el UI pueda
 * distinguir visualmente los matcheados de los pendientes.
 *
 * Filtros:
 *   ?accountId=<uuid>
 *   ?direction=IN|OUT
 *   ?since, ?until (YYYY-MM-DD)
 *   ?q=<search>
 *   ?minAmount, ?maxAmount
 *   ?onlyUnmatched=true   (default false; cuando true, solo IN sin Consolidado)
 *
 * Si se pasa ?accountId tambien devuelve `summary` con los conteos del
 * conjunto FILTRADO por cuenta (no afectado por los demas filtros, para que
 * el resumen del pie sea estable). Use `includeSummary=true` para incluirlo.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const direction = url.searchParams.get("direction");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const search = url.searchParams.get("q");
  const minAmount = url.searchParams.get("minAmount");
  const maxAmount = url.searchParams.get("maxAmount");
  const onlyUnmatched = url.searchParams.get("onlyUnmatched") === "true";
  // Vista "Movimientos descartados": "only" muestra solo los descartados;
  // por defecto se excluyen de todas las listas.
  const descartadosView = url.searchParams.get("descartados") === "only";
  const includeSummary = url.searchParams.get("includeSummary") === "true";
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100000, 0);

  // El threshold de "dif menor" se usa para marcar movimientos en el DTO
  // y para excluirlos del conteo "Sin matchear" en el summary del pie.
  const difSettings = await getDifMenorSettings();
  const difThreshold = difSettings.threshold;

  // Movimientos ya emitidos como Traspasos internos: ese matching se calcula
  // al vuelo (no crea Consolidado/AsientoManual), así que sin esto Cartolas
  // los sigue mostrando "Sin conciliar" para siempre aunque ya se hayan
  // emitido (bankMovementId queda registrado en EmisionConsumo al emitir).
  const emitidosTraspasos = await consumedRefIds("TRASPASOS_INTERNOS");

  const where: Prisma.BankMovementWhereInput = {};
  if (accountId) where.accountId = accountId;
  if (direction === "IN" || direction === "OUT") where.direction = direction;

  // Descartados: por defecto fuera; con ?descartados=only, solo ellos.
  where.descartadoAt = descartadosView ? { not: null } : null;
  // Manuales/ficticios: no se listan en Cartolas (no son cartola real; existen
  // solo para conciliar su Tesorería).
  where.manual = false;

  if (since || until) {
    where.postDate = {};
    if (since) (where.postDate as Prisma.DateTimeFilter).gte = new Date(since);
    if (until) {
      const end = new Date(until);
      end.setDate(end.getDate() + 1);
      (where.postDate as Prisma.DateTimeFilter).lt = end;
    }
  }

  if (minAmount || maxAmount) {
    where.amount = {};
    if (minAmount) (where.amount as Prisma.BigIntFilter).gte = BigInt(minAmount);
    if (maxAmount) (where.amount as Prisma.BigIntFilter).lte = BigInt(maxAmount);
  }

  if (search && search.trim() !== "") {
    where.OR = [
      { description: { contains: search, mode: "insensitive" } },
      { counterpartyName: { contains: search, mode: "insensitive" } },
      { counterpartyRut: { contains: search, mode: "insensitive" } },
      { externalId: { contains: search, mode: "insensitive" } },
    ];
  }

  if (onlyUnmatched) {
    // "Sin conciliar" = sin NINGUNA resolución: sin link del motor, sin
    // conciliación de egreso a tercero, sin asiento manual y sin emisión de
    // Traspasos internos. Aplica a ingresos Y egresos (respeta el filtro de
    // dirección que elija el usuario). Se excluyen abonos Transbank (tienen
    // su asiento propio) y cuentas de uso parcial.
    where.consolidadoLinks = { none: {} };
    where.egresoConciliacionLinks = { none: {} };
    where.asientoManual = { is: null };
    where.NOT = [
      {
        AND: [
          { description: { contains: "abn crd", mode: "insensitive" } },
          { description: { contains: "transba", mode: "insensitive" } },
        ],
      },
    ];
    where.account = { isNot: usoParcialAccountWhere };
    if (emitidosTraspasos.size > 0) {
      where.id = { notIn: Array.from(emitidosTraspasos) };
    }
  }

  const [rows, total] = await Promise.all([
    prisma.bankMovement.findMany({
      where,
      orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
      take: limit,
      skip: offset,
      include: {
        account: {
          select: {
            id: true,
            bankCode: true,
            bankName: true,
            holderName: true,
            displayNumber: true,
            accountNumber: true,
          },
        },
        consolidadoLinks: {
          include: {
            consolidado: { select: { id: true, status: true } },
          },
          take: 1,
        },
        // Conciliación de egreso a tercero (para el estado de los cargos/OUT).
        egresoConciliacionLinks: {
          include: { conciliacion: { select: { status: true } } },
          take: 1,
        },
        // Asiento manual generado (también cuenta como resuelto).
        asientoManual: { select: { id: true } },
      },
    }),
    prisma.bankMovement.count({ where }),
  ]);

  // Summary opcional por cuenta (cantidad y monto por categoria)
  let summary:
    | {
        total: number;
        inTotal: number;
        inConciliated: number;
        inPending: number;
        inSum: string;
        inConciliatedSum: string;
        inPendingSum: string;
        inTransbank: number;
        inTransbankSum: string;
        inDifMenor: number;
        inDifMenorSum: string;
        outTotal: number;
        outSum: string;
      }
    | null = null;
  if (includeSummary) {
    // Computar agregados. Cuando hay accountId, sobre esa cuenta; sino global
    // (todas las cuentas excepto _UNASSIGNED_*).
    // No aplicamos filtros de búsqueda/fecha para que el pie sea estable.
    // El predicado "dif menor" es: IN, amount > 0, amount <= threshold y
    // NO matchea Transbank (mutuamente excluyentes en el conteo).
    const accountAggs = accountId
      ? await prisma.$queryRaw<
          Array<{
            in_n: bigint;
            in_sum: bigint | null;
            in_rec_n: bigint;
            in_rec_sum: bigint | null;
            in_tbk_n: bigint;
            in_tbk_sum: bigint | null;
            in_dif_n: bigint;
            in_dif_sum: bigint | null;
            out_n: bigint;
            out_sum: bigint | null;
          }>
        >`
          SELECT
            COUNT(CASE WHEN direction='IN' THEN 1 END)::bigint AS in_n,
            COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END), 0)::bigint AS in_sum,
            COUNT(
              CASE
                WHEN direction='IN' AND (
                  EXISTS (
                    SELECT 1 FROM "ConsolidadoLink" cl
                    JOIN "Consolidado" c ON c.id = cl.consolidado_id
                    WHERE cl.bank_movement_id = bm.id
                      AND c.status IN ('AUTO_MATCHED','MANUAL')
                  )
                  OR EXISTS (
                    SELECT 1 FROM "EmisionConsumo" ec
                    JOIN "EmisionAsientos" ea ON ea.id = ec.emision_id
                    WHERE ec.ref_id = bm.id AND ea.origen = 'TRASPASOS_INTERNOS'
                  )
                )
                THEN 1
              END
            )::bigint AS in_rec_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN' AND (
                  EXISTS (
                    SELECT 1 FROM "ConsolidadoLink" cl
                    JOIN "Consolidado" c ON c.id = cl.consolidado_id
                    WHERE cl.bank_movement_id = bm.id
                      AND c.status IN ('AUTO_MATCHED','MANUAL')
                  )
                  OR EXISTS (
                    SELECT 1 FROM "EmisionConsumo" ec
                    JOIN "EmisionAsientos" ea ON ea.id = ec.emision_id
                    WHERE ec.ref_id = bm.id AND ea.origen = 'TRASPASOS_INTERNOS'
                  )
                )
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_rec_sum,
            COUNT(
              CASE
                WHEN direction='IN'
                  AND description ILIKE '%abn crd%'
                  AND description ILIKE '%transba%'
                THEN 1
              END
            )::bigint AS in_tbk_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN'
                  AND description ILIKE '%abn crd%'
                  AND description ILIKE '%transba%'
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_tbk_sum,
            COUNT(
              CASE
                WHEN direction='IN'
                  AND amount > 0
                  AND amount <= ${BigInt(difThreshold)}
                  AND NOT (
                    description ILIKE '%abn crd%' AND description ILIKE '%transba%'
                  )
                THEN 1
              END
            )::bigint AS in_dif_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN'
                  AND amount > 0
                  AND amount <= ${BigInt(difThreshold)}
                  AND NOT (
                    description ILIKE '%abn crd%' AND description ILIKE '%transba%'
                  )
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_dif_sum,
            COUNT(CASE WHEN direction='OUT' THEN 1 END)::bigint AS out_n,
            COALESCE(SUM(CASE WHEN direction='OUT' THEN ABS(amount) ELSE 0 END), 0)::bigint AS out_sum
          FROM "BankMovement" bm
          WHERE bm.account_id = ${accountId}
            AND bm.descartado_at IS NULL
        `
      : await prisma.$queryRaw<
          Array<{
            in_n: bigint;
            in_sum: bigint | null;
            in_rec_n: bigint;
            in_rec_sum: bigint | null;
            in_tbk_n: bigint;
            in_tbk_sum: bigint | null;
            in_dif_n: bigint;
            in_dif_sum: bigint | null;
            out_n: bigint;
            out_sum: bigint | null;
          }>
        >`
          SELECT
            COUNT(CASE WHEN direction='IN' THEN 1 END)::bigint AS in_n,
            COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE 0 END), 0)::bigint AS in_sum,
            COUNT(
              CASE
                WHEN direction='IN' AND (
                  EXISTS (
                    SELECT 1 FROM "ConsolidadoLink" cl
                    JOIN "Consolidado" c ON c.id = cl.consolidado_id
                    WHERE cl.bank_movement_id = bm.id
                      AND c.status IN ('AUTO_MATCHED','MANUAL')
                  )
                  OR EXISTS (
                    SELECT 1 FROM "EmisionConsumo" ec
                    JOIN "EmisionAsientos" ea ON ea.id = ec.emision_id
                    WHERE ec.ref_id = bm.id AND ea.origen = 'TRASPASOS_INTERNOS'
                  )
                )
                THEN 1
              END
            )::bigint AS in_rec_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN' AND (
                  EXISTS (
                    SELECT 1 FROM "ConsolidadoLink" cl
                    JOIN "Consolidado" c ON c.id = cl.consolidado_id
                    WHERE cl.bank_movement_id = bm.id
                      AND c.status IN ('AUTO_MATCHED','MANUAL')
                  )
                  OR EXISTS (
                    SELECT 1 FROM "EmisionConsumo" ec
                    JOIN "EmisionAsientos" ea ON ea.id = ec.emision_id
                    WHERE ec.ref_id = bm.id AND ea.origen = 'TRASPASOS_INTERNOS'
                  )
                )
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_rec_sum,
            COUNT(
              CASE
                WHEN direction='IN'
                  AND description ILIKE '%abn crd%'
                  AND description ILIKE '%transba%'
                THEN 1
              END
            )::bigint AS in_tbk_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN'
                  AND description ILIKE '%abn crd%'
                  AND description ILIKE '%transba%'
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_tbk_sum,
            COUNT(
              CASE
                WHEN direction='IN'
                  AND amount > 0
                  AND amount <= ${BigInt(difThreshold)}
                  AND NOT (
                    description ILIKE '%abn crd%' AND description ILIKE '%transba%'
                  )
                THEN 1
              END
            )::bigint AS in_dif_n,
            COALESCE(SUM(
              CASE
                WHEN direction='IN'
                  AND amount > 0
                  AND amount <= ${BigInt(difThreshold)}
                  AND NOT (
                    description ILIKE '%abn crd%' AND description ILIKE '%transba%'
                  )
                THEN amount
                ELSE 0
              END
            ), 0)::bigint AS in_dif_sum,
            COUNT(CASE WHEN direction='OUT' THEN 1 END)::bigint AS out_n,
            COALESCE(SUM(CASE WHEN direction='OUT' THEN ABS(amount) ELSE 0 END), 0)::bigint AS out_sum
          FROM "BankMovement" bm
          JOIN "BankAccount" ba ON ba.id = bm.account_id
          WHERE ba.account_number NOT LIKE '_UNASSIGNED_%'
            AND bm.descartado_at IS NULL
            AND NOT (${Prisma.raw(USO_PARCIAL_SQL)})
        `;
    const a = accountAggs[0];
    const inTotal = Number(a?.in_n ?? 0);
    const inRecCount = Number(a?.in_rec_n ?? 0);
    const inTbkCount = Number(a?.in_tbk_n ?? 0);
    const inDifCount = Number(a?.in_dif_n ?? 0);
    const inSum = a?.in_sum ?? 0n;
    const inRecSum = a?.in_rec_sum ?? 0n;
    const inTbkSum = a?.in_tbk_sum ?? 0n;
    const inDifSum = a?.in_dif_sum ?? 0n;

    // Si la cuenta seleccionada es de uso parcial, NADA cuenta como pendiente
    // (sus movimientos relevantes viven en Traspasos internos; el resto es no
    // relevante). El global ya excluye estas cuentas en el SQL.
    let selectedUsoParcial = false;
    if (accountId) {
      const acc = await prisma.bankAccount.findUnique({
        where: { id: accountId },
        select: { bankCode: true, accountNumber: true, displayNumber: true },
      });
      selectedUsoParcial = acc ? isUsoParcialAccount(acc) : false;
    }

    // Pendientes "Sin matchear" = IN sin conciliar y que NO son Transbank ni
    // dif menor. (Esos tienen su propio asiento contable en Consolidados.)
    const inPendingCount = selectedUsoParcial
      ? 0
      : inTotal - inRecCount - inTbkCount - inDifCount;
    const inPendingSum = selectedUsoParcial
      ? 0n
      : inSum - inRecSum - inTbkSum - inDifSum;
    summary = {
      total: inTotal + Number(a?.out_n ?? 0),
      inTotal,
      inConciliated: inRecCount,
      inPending: inPendingCount,
      inSum: inSum.toString(),
      inConciliatedSum: inRecSum.toString(),
      inPendingSum: inPendingSum.toString(),
      inTransbank: inTbkCount,
      inTransbankSum: inTbkSum.toString(),
      inDifMenor: inDifCount,
      inDifMenorSum: inDifSum.toString(),
      outTotal: Number(a?.out_n ?? 0),
      outSum: (a?.out_sum ?? 0n).toString(),
    };
  }

  return NextResponse.json({
    total,
    limit,
    offset,
    movements: rows.map((m) => {
      const link = m.consolidadoLinks[0];
      const consolidado = link
        ? { id: link.consolidado.id, status: link.consolidado.status }
        : null;
      const egresoLink = m.egresoConciliacionLinks[0];
      const egresoConciliado = egresoLink
        ? { status: egresoLink.conciliacion.status }
        : null;
      return {
        id: m.id,
        accountId: m.accountId,
        account: m.account,
        externalId: m.externalId,
        postDate: m.postDate.toISOString(),
        transactionDate: m.transactionDate?.toISOString() ?? null,
        amount: m.amount.toString(),
        currency: m.currency,
        direction: m.direction,
        description: m.description,
        balanceAfter: m.balanceAfter?.toString() ?? null,
        counterpartyName: m.counterpartyName,
        counterpartyRut: m.counterpartyRut,
        counterpartyBank: m.counterpartyBank,
        branchLabel: m.branchLabel,
        txType: m.txType,
        consolidado,
        egresoConciliado,
        asientoManual: m.asientoManual != null,
        traspasoInternoEmitido: emitidosTraspasos.has(m.id),
        transbank: isTransbank(m),
        comision: !isTransbank(m) && isComisionBancaria(m),
        // Prioridad: un cargo chico con glosa de comisión es comisión, no dif menor.
        difMenor: !isTransbank(m) && !isComisionBancaria(m) && isDifMenor(m, difThreshold),
        noRelevante: isUsoParcialAccount(m.account),
        descartadoAt: m.descartadoAt?.toISOString() ?? null,
      };
    }),
    summary,
  });
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  def: number
): number {
  if (raw === null) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
