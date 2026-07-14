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
 * GET /api/consolidados/dif-menor?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=&direction=IN|OUT
 *
 * Arma el asiento contable de los "diferencias menores": movimientos cuyo monto
 * absoluto está bajo el umbral configurable (default 100, inclusivo).
 *
 *  - direction=IN (default): ingresos chicos (transferencias de prueba que
 *    entran). Debe rubro cuenta / Haber rubro diferencia.
 *  - direction=OUT: egresos chicos (transferencias de prueba que salen para
 *    validar una cuenta destino). Asiento INVERTIDO: Debe rubro diferencia /
 *    Haber rubro cuenta. Mismo rubro diferencia (2050), del otro lado.
 *
 * Cada BankMovement genera 2 filas (banco + contracuenta diferencia). El rubro
 * de la cuenta se infiere por nombre del catálogo RubroLabel.
 *
 * Excluye los Transbank (tienen su propio asiento) y las cuentas de uso parcial.
 * No hay deshacer contra Tesorería; la resolución es vía emisión (folio).
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
  const direction = url.searchParams.get("direction") === "OUT" ? "OUT" : "IN";

  const settings = await getDifMenorSettings();

  // Filtro de monto según dirección: IN = positivo (0, umbral]; OUT = negativo
  // [-umbral, 0) (los egresos se guardan con monto negativo).
  const amountWhere =
    direction === "IN"
      ? { gt: 0n, lte: BigInt(settings.threshold) }
      : { lt: 0n, gte: -BigInt(settings.threshold) };
  const origenEmision = direction === "OUT" ? "DIF_MENOR_EGRESO" : "DIF_MENOR";

  // Diferencias ya emitidas a gestión (folio): fuera del listado de esta tab.
  const emitidos = await consumedRefIds(origenEmision);

  const movements = await prisma.bankMovement.findMany({
    where: {
      direction,
      amount: amountWhere,
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

    // Lados del asiento según dirección:
    //   IN  (ingreso): banco DEBE  / diferencia HABER
    //   OUT (egreso):  banco HABER / diferencia DEBE  (invertido)
    const bancoDebe = direction === "IN" ? abs.toString() : null;
    const bancoHaber = direction === "IN" ? null : abs.toString();
    const difDebe = direction === "IN" ? null : abs.toString();
    const difHaber = direction === "IN" ? abs.toString() : null;

    // 1) Lado banco
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
      debe: bancoDebe,
      haber: bancoHaber,
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });

    // 2) Contracuenta diferencia
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
      debe: difDebe,
      haber: difHaber,
      bankMovementId: bm.id,
      totalMonto: abs.toString(),
    });

    // Cada movimiento aporta abs a ambos totales (siempre cuadra).
    totalDebe += abs;
    totalHaber += abs;
  }

  // Facets de cuenta vistas en el rango completo (sin filtro de cuenta).
  const allInRange = await prisma.bankMovement.findMany({
    where: {
      direction,
      amount: amountWhere,
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
