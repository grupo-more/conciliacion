import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  getDifMenorSettings,
  inferRubroByAccount,
} from "@/lib/dif-menor/detect";
import { transbankPrismaWhere } from "@/lib/transbank/detect";
import { usoParcialAccountWhere } from "@/lib/cuentas/uso-parcial";
import { consumedRefIds } from "@/lib/consolidados/emision-consumo";

/**
 * GET /api/consolidados/dif-menor?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=
 *
 * Arma el asiento contable de los "diferencias menores": ingresos IN cuyo
 * monto absoluto está bajo el umbral configurable (default 100, inclusivo).
 *
 * Cada BankMovement genera 2 filas:
 *  - Debe rubro de la cuenta (inferido por nombre del catálogo RubroLabel).
 *  - Haber rubro diferencia (configurable, default 2050).
 *
 * Excluye los Transbank (esos tienen su propio asiento y nunca son <100).
 * No hay deshacer porque no hay match contra TesoreriaMovement.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );
  const accountId = url.searchParams.get("accountId") || null;

  const settings = await getDifMenorSettings();

  // Diferencias ya emitidas a gestión (folio): fuera del listado de esta tab.
  const emitidos = await consumedRefIds("DIF_MENOR");

  const movements = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      amount: { gt: 0n, lte: BigInt(settings.threshold) },
      postDate: { gte: from, lt: to },
      ...(accountId ? { accountId } : {}),
      ...(emitidos.size > 0 ? { id: { notIn: Array.from(emitidos) } } : {}),
      descartadoAt: null,
      // Cuentas de uso parcial: fuera de scope.
      account: { isNot: usoParcialAccountWhere },
      // Excluir Transbank por consistencia (aunque nunca son < threshold).
      NOT: [
        {
          AND: transbankPrismaWhere.AND,
        },
      ],
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
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    take: 2000,
  });

  // Inferir el rubro de cada cuenta involucrada en los movimientos.
  const accountIdsInUse = Array.from(
    new Set(movements.map((m) => m.accountId))
  );
  const rubroByAccount = await inferRubroByAccount(accountIdsInUse);

  // Etiquetas: los rubros usados (banco + diferencia)
  const rubrosNeeded = new Set<number>([settings.rubroDiferencia]);
  for (const r of rubroByAccount.values()) rubrosNeeded.add(r);
  const rubroLabels =
    rubrosNeeded.size > 0
      ? await prisma.rubroLabel.findMany({
          where: { rubro: { in: Array.from(rubrosNeeded) } },
          select: { rubro: true, name: true },
        })
      : [];
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));
  const labelDiferencia =
    labelByRubro.get(settings.rubroDiferencia) ?? "Diferencia";

  const rows: DifMenorRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const bm of movements) {
    const abs = bm.amount < 0n ? -bm.amount : bm.amount;
    const glosa = bm.description?.trim() || "";
    const cliente = bm.counterpartyName?.trim() || "—";
    const groupId = bm.id;

    const rubroBanco = rubroByAccount.get(bm.accountId) ?? null;
    const detalleBanco =
      (rubroBanco !== null ? labelByRubro.get(rubroBanco) : null) ??
      bm.account.bankName;

    // 1) Lado banco — Debe
    rows.push({
      groupId,
      side: "BANCO",
      fecha: bm.postDate.toISOString(),
      rubro: rubroBanco,
      rubroLabel: rubroBanco !== null ? labelByRubro.get(rubroBanco) ?? null : null,
      detalle: detalleBanco,
      cuenta: bm.account.displayNumber || bm.account.accountNumber,
      cliente,
      glosa,
      debe: abs.toString(),
      haber: null,
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });
    totalDebe += abs;

    // 2) Contracuenta diferencia — Haber
    rows.push({
      groupId,
      side: "DIFERENCIA",
      fecha: bm.postDate.toISOString(),
      rubro: settings.rubroDiferencia,
      rubroLabel: labelDiferencia,
      detalle: labelDiferencia,
      cuenta: bm.account.displayNumber || bm.account.accountNumber,
      cliente,
      glosa,
      debe: null,
      haber: abs.toString(),
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });
    totalHaber += abs;
  }

  // Facets de cuenta vistas en el rango completo (sin filtro de cuenta).
  const allInRange = await prisma.bankMovement.findMany({
    where: {
      direction: "IN",
      amount: { gt: 0n, lte: BigInt(settings.threshold) },
      postDate: { gte: from, lt: to },
      descartadoAt: null,
      account: { isNot: usoParcialAccountWhere },
      NOT: [{ AND: transbankPrismaWhere.AND }],
    },
    select: { accountId: true },
    distinct: ["accountId"],
  });
  const facetAccountIds = allInRange.map((r) => r.accountId);
  const accountList =
    facetAccountIds.length > 0
      ? await prisma.bankAccount.findMany({
          where: { id: { in: facetAccountIds } },
          select: {
            id: true,
            bankName: true,
            displayNumber: true,
            accountNumber: true,
            holderName: true,
          },
        })
      : [];

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    settings,
    rows,
    totals: { debe: totalDebe.toString(), haber: totalHaber.toString() },
    facets: {
      accounts: accountList
        .map((a) => ({
          id: a.id,
          label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  });
}

interface DifMenorRow {
  groupId: string;
  side: "BANCO" | "DIFERENCIA";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  cuenta: string;
  cliente: string;
  glosa: string;
  debe: string | null;
  haber: string | null;
  bankMovementId: string;
  totalMonto: string;
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null
): { from: Date; to: Date } {
  if (fromRaw && toRaw) {
    const from = parseDateOnly(fromRaw);
    const to = parseDateOnly(toRaw);
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setDate(toEnd.getDate() + 1);
      return { from, to: toEnd };
    }
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

function parseDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
