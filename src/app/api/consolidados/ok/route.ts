import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/consolidados/ok?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=&rubroSucursal=
 *
 * Devuelve el asiento contable de partida doble para los Consolidados
 * conciliados (status AUTO_MATCHED | MANUAL) en el rango pedido.
 *
 * Reglas de armado por Consolidado:
 *  - 1 fila BANCO por cada BankMovement vinculado (lado banco se desdobla
 *    en splits para reflejar cada transferencia tal cual entra al extracto).
 *  - 1 fila SUCURSAL con el monto del TesoreriaMovement (siempre una sola,
 *    porque el origen es 1 documento de Tesorería).
 *  - 1 fila AJUSTE si Consolidado.adjustmentAmount != null (diferencia
 *    entre lo cobrado por la sucursal y lo que entró al banco).
 *
 * Convención Debe/Haber:
 *  - Abono al banco (direction IN):  Debe Banco / Haber Sucursal
 *  - Cargo al banco  (direction OUT): Haber Banco / Debe Sucursal
 *  - Ajuste: el lado se elige para que cuadre Debe = Haber.
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
  const rubroSucursalRaw = url.searchParams.get("rubroSucursal");
  const rubroSucursal =
    rubroSucursalRaw && /^-?\d+$/.test(rubroSucursalRaw)
      ? Number(rubroSucursalRaw)
      : null;

  const consolidados = await prisma.consolidado.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      tesoreriaMovement: {
        // OK = ingresos (clientes). Los egresos (tipoOperacion=EGRESO) van a la
        // tab "Egresos a terceros → Conciliados (asiento)".
        tipoOperacion: "INGRESO",
        fecha: { gte: from, lt: to },
        ...(rubroSucursal !== null ? { rubroSucursal } : {}),
      },
      ...(accountId ? { resolvedAccountId: accountId } : {}),
    },
    include: {
      tesoreriaMovement: true,
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
    orderBy: { tesoreriaMovement: { fecha: "desc" } },
    take: 2000,
  });

  // Pre-cargar todas las etiquetas de rubro en un solo query.
  const rubroCodes = new Set<number>();
  for (const c of consolidados) {
    if (c.tesoreriaMovement.rubroBanco !== null) rubroCodes.add(c.tesoreriaMovement.rubroBanco);
    if (c.tesoreriaMovement.rubroSucursal !== null) rubroCodes.add(c.tesoreriaMovement.rubroSucursal);
    if (c.adjustmentRubro !== null) rubroCodes.add(c.adjustmentRubro);
    if (c.overrideRubroBanco !== null) rubroCodes.add(c.overrideRubroBanco);
  }
  const rubroLabels =
    rubroCodes.size > 0
      ? await prisma.rubroLabel.findMany({
          where: { rubro: { in: Array.from(rubroCodes) } },
          select: { rubro: true, name: true },
        })
      : [];
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));

  const rows: OKRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const c of consolidados) {
    const tm = c.tesoreriaMovement;
    if (c.links.length === 0) continue; // por seguridad — AUTO/MANUAL deberían tener ≥1

    // Asumimos que todos los links del consolidado son del mismo direction
    // (un consolidado no mezcla abonos y cargos). Tomamos el primero.
    const direction = c.links[0].bankMovement.direction;
    const isAbono = direction === "IN";
    const cliente = buildCliente(
      c.links[0].bankMovement.counterpartyName,
      tm.clienteName
    );
    const glosa =
      c.links[0].bankMovement.description?.trim() || tm.glosa?.trim() || "";
    const groupId = c.id;

    const rubroSuc = tm.rubroSucursal;
    const detalleSucursal =
      labelByRubro.get(rubroSuc ?? -1) ??
      tm.sucursalName ??
      (tm.sucursalId ? `Sucursal ${tm.sucursalId}` : "—");

    // Cascada para el rubro banco efectivo:
    //   override (Consolidado.overrideRubroBanco, se setea en el match manual
    //   cuando el operador detecta que el rubroBanco que vino de Tesorería
    //   está mal porque ellos tipearon mal el banco al cargar)
    //   → tm.rubroBanco (la API, default)

    // 1 fila por cada BankMovement (lado banco).
    //
    // En split inverso (1 cartola repartida en N tesorerías), cada
    // ConsolidadoLink trae amountAllocated con la porción que va a ESTE
    // consolidado, no el bm.amount completo. Para el caso 1:1 / N:1
    // histórico, amountAllocated es null y se usa bm.amount entero
    // (semántica legacy intacta).
    let bankSum = 0n;
    for (const link of c.links) {
      const bm = link.bankMovement;
      const linkAmount = link.amountAllocated ?? bm.amount;
      const abs = linkAmount < 0n ? -linkAmount : linkAmount;
      bankSum += abs;

      const effectiveRubroBanco = c.overrideRubroBanco ?? tm.rubroBanco;
      const detalleBanco =
        labelByRubro.get(effectiveRubroBanco ?? -1) ?? bm.account.bankName ?? "—";

      rows.push({
        groupId,
        side: "BANCO",
        fecha: bm.postDate.toISOString(),
        rubro: effectiveRubroBanco,
        rubroLabel: labelByRubro.get(effectiveRubroBanco ?? -1) ?? null,
        detalle: detalleBanco,
        cliente,
        glosa: bm.description?.trim() || glosa,
        debe: isAbono ? abs.toString() : null,
        haber: isAbono ? null : abs.toString(),
        consolidadoId: c.id,
        tesoreriaId: tm.id,
        bankMovementId: bm.id,
        status: c.status as "AUTO_MATCHED" | "MANUAL",
        totalMonto: tm.monto.toString(),
      });

      if (isAbono) totalDebe += abs;
      else totalHaber += abs;
    }

    // 1 fila SUCURSAL con el monto del TesoreriaMovement
    const tesoreriaAmount = tm.monto;
    rows.push({
      groupId,
      side: "SUCURSAL",
      fecha: tm.fecha.toISOString(),
      rubro: rubroSuc,
      rubroLabel: labelByRubro.get(rubroSuc ?? -1) ?? null,
      detalle: detalleSucursal,
      cliente,
      glosa,
      debe: isAbono ? null : tesoreriaAmount.toString(),
      haber: isAbono ? tesoreriaAmount.toString() : null,
      consolidadoId: c.id,
      tesoreriaId: tm.id,
      bankMovementId: null,
      status: c.status as "AUTO_MATCHED" | "MANUAL",
      totalMonto: tm.monto.toString(),
    });
    if (isAbono) totalHaber += tesoreriaAmount;
    else totalDebe += tesoreriaAmount;

    // 1 fila AJUSTE si existe
    if (c.adjustmentAmount !== null && c.adjustmentAmount !== 0n) {
      const absDiff = c.adjustmentAmount;
      const diff = bankSum - tesoreriaAmount; // con signo
      // Lado del ajuste: el que falta para que cuadre Debe = Haber.
      // Si diff > 0 e IN  → Debe excede en absDiff → Haber del ajuste.
      // Si diff < 0 e IN  → Haber excede en absDiff → Debe del ajuste.
      // Si diff > 0 e OUT → Haber excede → Debe del ajuste.
      // Si diff < 0 e OUT → Debe excede → Haber del ajuste.
      const ajusteAlHaber = (diff > 0n && isAbono) || (diff < 0n && !isAbono);
      const rubroAj = c.adjustmentRubro;
      const detalleAj =
        (rubroAj !== null ? labelByRubro.get(rubroAj) : null) ?? "Ajuste";

      rows.push({
        groupId,
        side: "AJUSTE",
        fecha: tm.fecha.toISOString(),
        rubro: rubroAj,
        rubroLabel: rubroAj !== null ? labelByRubro.get(rubroAj) ?? null : null,
        detalle: detalleAj,
        cliente,
        glosa: c.adjustmentNote?.trim() || "Ajuste por diferencia",
        debe: ajusteAlHaber ? null : absDiff.toString(),
        haber: ajusteAlHaber ? absDiff.toString() : null,
        consolidadoId: c.id,
        tesoreriaId: tm.id,
        bankMovementId: null,
        status: c.status as "AUTO_MATCHED" | "MANUAL",
        totalMonto: tm.monto.toString(),
      });
      if (ajusteAlHaber) totalHaber += absDiff;
      else totalDebe += absDiff;
    }
  }

  // Facets: cuentas y rubros de sucursal vistos en el rango (no filtrados).
  const allInRange = await prisma.consolidado.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      tesoreriaMovement: { tipoOperacion: "INGRESO", fecha: { gte: from, lt: to } },
    },
    select: {
      resolvedAccountId: true,
      tesoreriaMovement: { select: { rubroSucursal: true } },
    },
  });
  const accountIds = new Set<string>();
  const rubroSucSet = new Set<number>();
  for (const r of allInRange) {
    if (r.resolvedAccountId) accountIds.add(r.resolvedAccountId);
    if (r.tesoreriaMovement.rubroSucursal !== null)
      rubroSucSet.add(r.tesoreriaMovement.rubroSucursal);
  }
  const accountList =
    accountIds.size > 0
      ? await prisma.bankAccount.findMany({
          where: { id: { in: Array.from(accountIds) } },
          select: {
            id: true,
            bankName: true,
            displayNumber: true,
            accountNumber: true,
            holderName: true,
          },
        })
      : [];
  const rubroSucList = Array.from(rubroSucSet).sort((a, b) => a - b);
  const rubroLabelsForFacet =
    rubroSucList.length > 0
      ? await prisma.rubroLabel.findMany({
          where: { rubro: { in: rubroSucList } },
          select: { rubro: true, name: true },
        })
      : [];
  const facetLabelByRubro = new Map(
    rubroLabelsForFacet.map((r) => [r.rubro, r.name])
  );

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: { debe: totalDebe.toString(), haber: totalHaber.toString() },
    facets: {
      accounts: accountList
        .map((a) => ({
          id: a.id,
          label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      rubrosSucursales: rubroSucList.map((r) => ({
        rubro: r,
        label: facetLabelByRubro.get(r) ?? null,
      })),
    },
  });
}

interface OKRow {
  /** Identificador del grupo (consolidadoId). Filas con mismo groupId pertenecen al mismo asiento. */
  groupId: string;
  side: "BANCO" | "SUCURSAL" | "AJUSTE";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  cliente: string;
  glosa: string;
  debe: string | null;
  haber: string | null;
  status: "AUTO_MATCHED" | "MANUAL";
  totalMonto: string;
  consolidadoId: string;
  tesoreriaId: string;
  bankMovementId: string | null;
}

function buildCliente(
  banco: string | null,
  tesoreria: string | null
): string {
  const b = banco?.trim() || null;
  const t = tesoreria?.trim() || null;
  if (b && t) {
    if (b.toLowerCase() === t.toLowerCase()) return b;
    return `${b} / ${t}`;
  }
  return b || t || "—";
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
