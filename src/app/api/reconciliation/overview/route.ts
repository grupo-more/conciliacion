import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getPeriodRange, type Period } from "@/lib/dashboard/queries";

/**
 * GET /api/reconciliation/overview?period=day|week|month
 *
 * Vista pareada del módulo de conciliación. Devuelve:
 *  - KPIs agregados del período (conciliado, pendiente, fuera de scope, sin contraparte banco)
 *  - rows: lista cronológica ascendente que mezcla
 *       · PAIR: venta Dynatech (con o sin sus bank movements asociados)
 *       · BANK_ORPHAN: abono bancario sin Reconciliation
 *  - facets: sucursales y cuentas para filtros
 *
 * Filtros opcionales:
 *  ?branchId=<int>     filtrar por sucursal Dynatech
 *  ?accountId=<uuid>   filtrar por cuenta bancaria
 *  ?status=<csv>       AUTO_MATCHED,SUGGESTED,REVIEW,MANUAL,NO_MATCH,OUT_OF_SCOPE,UNPROCESSED,UNPAIRED_BANK
 *  ?q=<texto>          búsqueda libre en obs/cliente/glosa banco
 */

const ALL_PAIR_STATUSES = [
  "AUTO_MATCHED",
  "MANUAL",
  "SUGGESTED",
  "REVIEW",
  "NO_MATCH",
  "OUT_OF_SCOPE",
  "UNPROCESSED",
] as const;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const periodRaw = url.searchParams.get("period") || "month";
  const period: Period =
    periodRaw === "day" || periodRaw === "week" || periodRaw === "month"
      ? periodRaw
      : "month";

  const branchIdRaw = url.searchParams.get("branchId");
  const branchId = branchIdRaw ? parseInt(branchIdRaw, 10) : null;
  const accountId = url.searchParams.get("accountId");
  const statusCsv = url.searchParams.get("status");
  const statusFilter = statusCsv
    ? new Set(statusCsv.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const search = (url.searchParams.get("q") || "").trim();

  const range = getPeriodRange(period);

  // Ventas Dynatech del período + su reconciliation y links (si los hay)
  const ventasRows = await prisma.dynatechMovement.findMany({
    where: {
      occurredAt: { gte: range.start, lt: range.end },
      ...(branchId !== null && !Number.isNaN(branchId)
        ? { branchExternalId: branchId }
        : {}),
      // Solo Ventas: items[0].nombre comienza con "Venta de"
      items: {
        path: ["0", "nombre"],
        string_contains: "Venta de",
      },
      ...(search
        ? {
            OR: [
              { observation: { contains: search, mode: "insensitive" as const } },
              { customerName: { contains: search, mode: "insensitive" as const } },
              { customerRut: { contains: search, mode: "insensitive" as const } },
              { branchExternalName: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: {
      reconciliation: {
        include: {
          links: {
            include: {
              bankMovement: {
                include: {
                  account: {
                    select: {
                      id: true,
                      bankCode: true,
                      bankName: true,
                      accountNumber: true,
                      displayNumber: true,
                      holderName: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { occurredAt: "asc" },
  });

  // Abonos banco del período sin reconciliation (huérfanos)
  const orphanBank = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      postDate: { gte: range.start, lt: range.end },
      reconciliationLinks: { none: {} },
      account: {
        accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
      },
      ...(accountId ? { accountId } : {}),
      ...(search
        ? {
            OR: [
              { description: { contains: search, mode: "insensitive" as const } },
              { counterpartyName: { contains: search, mode: "insensitive" as const } },
              { counterpartyRut: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
        },
      },
    },
    orderBy: { postDate: "asc" },
  });

  // Si se filtra por accountId, eliminar pares cuyos links no estén en esa cuenta.
  const ventasFiltered = accountId
    ? ventasRows.filter((v) => {
        const links = v.reconciliation?.links ?? [];
        if (links.length === 0) return true; // sin links: visible
        return links.every((l) => l.bankMovement.accountId === accountId);
      })
    : ventasRows;

  // Construir filas de pares
  const pairRows = ventasFiltered.map((v) => {
    const links = v.reconciliation?.links ?? [];
    const status = v.reconciliation?.status ?? "UNPROCESSED";
    const matchType = v.reconciliation?.matchType ?? null;
    const banksSum = links.reduce((acc, l) => acc + l.bankMovement.amount, 0n);

    return {
      kind: "PAIR" as const,
      sortDate: v.occurredAt.toISOString(),
      dynatech: {
        id: v.id,
        reconciliationId: v.reconciliation?.id ?? null,
        mCjId: v.mCjId.toString(),
        branchExternalId: v.branchExternalId,
        branchExternalName: v.branchExternalName,
        cashierUsername: v.cashierUsername,
        cashierName: v.cashierName,
        customerName: v.customerName,
        customerRut: v.customerRut,
        occurredAt: v.occurredAt.toISOString(),
        observation: v.observation,
        totalAmount: v.totalAmount.toString(),
        currency: v.currency,
        documentCode: v.documentCode,
        documentFolio: v.documentFolio.toString(),
        items: v.items,
      },
      status,
      matchType,
      outOfScopeReason: v.reconciliation?.outOfScopeReason ?? null,
      banks: links.map((l) => ({
        id: l.bankMovement.id,
        accountId: l.bankMovement.accountId,
        account: l.bankMovement.account,
        postDate: l.bankMovement.postDate.toISOString(),
        amount: l.bankMovement.amount.toString(),
        currency: l.bankMovement.currency,
        description: l.bankMovement.description,
        counterpartyName: l.bankMovement.counterpartyName,
        counterpartyRut: l.bankMovement.counterpartyRut,
        externalId: l.bankMovement.externalId,
      })),
      banksSum: banksSum.toString(),
    };
  });

  // Filas de huérfanos banco
  const orphanRows = orphanBank.map((b) => ({
    kind: "BANK_ORPHAN" as const,
    sortDate: b.postDate.toISOString(),
    status: "UNPAIRED_BANK" as const,
    bank: {
      id: b.id,
      accountId: b.accountId,
      account: b.account,
      postDate: b.postDate.toISOString(),
      amount: b.amount.toString(),
      currency: b.currency,
      description: b.description,
      counterpartyName: b.counterpartyName,
      counterpartyRut: b.counterpartyRut,
      externalId: b.externalId,
    },
  }));

  // KPIs sobre todo lo del período (antes de filtrar por status)
  const kpis = {
    conciliated: emptyBucket(),
    pending: emptyBucket(),
    outOfScope: emptyBucket(),
    unpairedBank: emptyBucket(),
  };
  for (const r of pairRows) {
    const amount = Number(r.dynatech.totalAmount);
    if (r.status === "AUTO_MATCHED" || r.status === "MANUAL") {
      kpis.conciliated.count++;
      kpis.conciliated.sum += amount;
    } else if (r.status === "OUT_OF_SCOPE") {
      kpis.outOfScope.count++;
      kpis.outOfScope.sum += amount;
    } else {
      kpis.pending.count++;
      kpis.pending.sum += amount;
    }
  }
  for (const r of orphanRows) {
    kpis.unpairedBank.count++;
    kpis.unpairedBank.sum += Number(r.bank.amount);
  }

  // Aplicar filtro por status al final
  const allRows = [...pairRows, ...orphanRows].filter((r) => {
    if (!statusFilter) return true;
    return statusFilter.has(r.status);
  });

  // Orden cronológico ascendente
  allRows.sort((a, b) =>
    a.sortDate < b.sortDate ? -1 : a.sortDate > b.sortDate ? 1 : 0
  );

  // Facets
  const [branches, accounts] = await Promise.all([
    prisma.dynatechMovement.groupBy({
      by: ["branchExternalId", "branchExternalName"],
      orderBy: [{ branchExternalId: "asc" }],
    }),
    prisma.bankAccount.findMany({
      where: {
        active: true,
        accountNumber: { not: { startsWith: "_UNASSIGNED_" } },
      },
      select: {
        id: true,
        bankCode: true,
        bankName: true,
        accountNumber: true,
        displayNumber: true,
        holderName: true,
      },
      orderBy: [{ bankCode: "asc" }, { holderName: "asc" }],
    }),
  ]);

  return NextResponse.json({
    period,
    range: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      label: range.label,
    },
    kpis,
    rows: allRows,
    facets: {
      branches: branches.map((b) => ({
        id: b.branchExternalId,
        name: b.branchExternalName,
      })),
      accounts,
      statuses: [...ALL_PAIR_STATUSES, "UNPAIRED_BANK"],
    },
    generatedAt: new Date().toISOString(),
  });
}

function emptyBucket() {
  return { count: 0, sum: 0 };
}
