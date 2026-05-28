import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/consolidados/ok?from=YYYY-MM-DD&to=YYYY-MM-DD&accountId=&rubroSucursal=
 *
 * Devuelve el asiento contable de partida doble para los Consolidados
 * conciliados (status AUTO_MATCHED | MANUAL) en el rango pedido.
 *
 * Cada ConsolidadoLink (vínculo BankMovement <-> TesoreriaMovement) genera
 * 2 filas: una con el rubro del banco y otra con el rubro de la sucursal.
 *
 * Convención Debe/Haber:
 *  - Abono al banco (direction "IN"):  Debe Banco / Haber Sucursal
 *  - Cargo al banco  (direction "OUT"): Haber Banco / Debe Sucursal
 *
 * Defaults: si no se pasan `from`/`to`, usa el mes calendario en curso.
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

  // Pre-cargar todas las etiquetas de rubro que se referencian, en un solo query.
  const rubroCodes = new Set<number>();
  for (const c of consolidados) {
    if (c.tesoreriaMovement.rubroBanco !== null) {
      rubroCodes.add(c.tesoreriaMovement.rubroBanco);
    }
    if (c.tesoreriaMovement.rubroSucursal !== null) {
      rubroCodes.add(c.tesoreriaMovement.rubroSucursal);
    }
  }
  const rubroLabels =
    rubroCodes.size > 0
      ? await prisma.rubroLabel.findMany({
          where: { rubro: { in: Array.from(rubroCodes) } },
          select: { rubro: true, name: true },
        })
      : [];
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));

  // Armar las filas del asiento.
  const rows: OKRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const c of consolidados) {
    const tm = c.tesoreriaMovement;
    for (let i = 0; i < c.links.length; i++) {
      const link = c.links[i];
      const bm = link.bankMovement;
      const isAbono = bm.direction === "IN";
      const abs = bm.amount < 0n ? -bm.amount : bm.amount;

      const cliente = buildCliente(bm.counterpartyName, tm.clienteName);
      const glosa = bm.description?.trim() || tm.glosa?.trim() || "";
      const pairId = `${c.id}__${link.id}`;

      const rubroBanco = tm.rubroBanco;
      const rubroSuc = tm.rubroSucursal;

      const detalleBanco =
        labelByRubro.get(rubroBanco ?? -1) ??
        bm.account.bankName ??
        "—";
      const detalleSucursal =
        labelByRubro.get(rubroSuc ?? -1) ??
        tm.sucursalName ??
        (tm.sucursalId ? `Sucursal ${tm.sucursalId}` : "—");

      // Lado banco
      rows.push({
        pairId,
        side: "BANCO",
        fecha: bm.postDate.toISOString(),
        rubro: rubroBanco,
        rubroLabel: labelByRubro.get(rubroBanco ?? -1) ?? null,
        detalle: detalleBanco,
        cliente,
        glosa,
        debe: isAbono ? abs.toString() : null,
        haber: isAbono ? null : abs.toString(),
        consolidadoId: c.id,
        tesoreriaId: tm.id,
        bankMovementId: bm.id,
      });

      // Lado sucursal (contracuenta)
      rows.push({
        pairId,
        side: "SUCURSAL",
        fecha: bm.postDate.toISOString(),
        rubro: rubroSuc,
        rubroLabel: labelByRubro.get(rubroSuc ?? -1) ?? null,
        detalle: detalleSucursal,
        cliente,
        glosa,
        debe: isAbono ? null : abs.toString(),
        haber: isAbono ? abs.toString() : null,
        consolidadoId: c.id,
        tesoreriaId: tm.id,
        bankMovementId: bm.id,
      });

      if (isAbono) {
        totalDebe += abs;
        totalHaber += abs;
      } else {
        totalHaber += abs;
        totalDebe += abs;
      }
    }
  }

  // Facets: cuentas y rubros de sucursal vistos en el rango (no filtrados),
  // para poblar los selects del front sin recargas extra.
  const allConsolidadosInRange = await prisma.consolidado.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      tesoreriaMovement: { fecha: { gte: from, lt: to } },
    },
    select: {
      resolvedAccountId: true,
      tesoreriaMovement: { select: { rubroSucursal: true } },
    },
  });
  const accountIds = new Set<string>();
  const rubroSucSet = new Set<number>();
  for (const r of allConsolidadosInRange) {
    if (r.resolvedAccountId) accountIds.add(r.resolvedAccountId);
    if (r.tesoreriaMovement.rubroSucursal !== null) {
      rubroSucSet.add(r.tesoreriaMovement.rubroSucursal);
    }
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
  pairId: string;
  side: "BANCO" | "SUCURSAL";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  cliente: string;
  glosa: string;
  debe: string | null;
  haber: string | null;
  consolidadoId: string;
  tesoreriaId: string;
  bankMovementId: string;
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
      toEnd.setDate(toEnd.getDate() + 1); // upper bound exclusivo
      return { from, to: toEnd };
    }
  }
  // Default: mes calendario en curso (día 1 → mañana 00:00)
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
