import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import {
  buildRubroMap,
  type AccountForRubro,
} from "@/lib/internos/rubro-resolver";

/**
 * GET /api/consolidados/egresos-terceros/asiento?from&to&accountId
 *
 * Asiento contable (partida doble) de los EGRESOS a terceros CONCILIADOS contra
 * Dynatech: Consolidado (status AUTO_MATCHED | MANUAL) de un TesoreriaMovement
 * con tipoOperacion=EGRESO. Convención (cargo al banco):
 *   DEBE  = rubro del gasto (lado Tesorería / sucursal)
 *   HABER = cuenta banco (BankMovement OUT)
 *
 * Espeja la pestaña OK pero del lado egresos — OK ahora muestra solo ingresos
 * (clientes) y los egresos viven en su propia tab.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const accountId = url.searchParams.get("accountId") || null;

  const concs = await prisma.consolidado.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      tesoreriaMovement: {
        tipoOperacion: "EGRESO",
        fecha: { gte: from, lt: to },
      },
      ...(accountId ? { resolvedAccountId: accountId } : {}),
    },
    include: {
      tesoreriaMovement: true,
      links: { include: { bankMovement: { include: { account: true } } } },
    },
    orderBy: { tesoreriaMovement: { fecha: "desc" } },
    take: 2000,
  });

  // Etiquetas de rubro + resolución del rubro banco por cuenta. Mismo
  // resolver que Traspasos internos: enlace explícito RubroLabel.accountId
  // (Configuración → Rubros) → match por nombre → rubro de la EntidadInterna.
  const [rubroLabels, entidades] = await Promise.all([
    prisma.rubroLabel.findMany({
      select: { rubro: true, name: true, accountId: true, isDifference: true },
    }),
    loadEntidadesInternas(prisma),
  ]);
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));

  const accountsForRubro: AccountForRubro[] = [];
  const seenAccountIds = new Set<string>();
  for (const c of concs) {
    for (const l of c.links) {
      const a = l.bankMovement.account;
      if (seenAccountIds.has(a.id)) continue;
      seenAccountIds.add(a.id);
      accountsForRubro.push({
        id: a.id,
        bankName: a.bankName,
        holderName: a.holderName,
        holderRut: a.holderRut,
      });
    }
  }
  const rubroByAccount = buildRubroMap(
    accountsForRubro,
    rubroLabels.filter((r) => !r.isDifference),
    entidades.map((e) => ({ rutCanonico: e.rutCanonico, rubro: e.rubro })),
  );

  type Row = {
    groupId: string;
    side: "GASTO" | "BANCO";
    fecha: string;
    rubro: number | null;
    rubroLabel: string | null;
    detalle: string;
    cuenta: string | null;
    glosa: string;
    /** Contraparte (proveedor): para la descripción del asiento (contraparte → glosa). */
    counterparty: string | null;
    debe: string | null;
    haber: string | null;
    status: string;
    egresoExternalId: string;
    bankMovementId: string | null;
  };

  const rows: Row[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const c of concs) {
    if (c.links.length === 0) continue;
    if (accountId && !c.links.some((l) => l.bankMovement.accountId === accountId)) continue;

    const tm = c.tesoreriaMovement;
    const rubroGasto = tm.rubroSucursal ?? tm.rubroBanco;
    const detalleGasto =
      labelByRubro.get(rubroGasto ?? -1) ??
      tm.sucursalName ??
      (tm.sucursalId ? `Sucursal ${tm.sucursalId}` : "Gasto");
    const absTm = tm.monto < 0n ? -tm.monto : tm.monto;

    // Contraparte (proveedor): del documento de Tesorería o de la cartola vinculada.
    const counterparty =
      tm.clienteName?.trim() || c.links[0]?.bankMovement.counterpartyName || null;

    // Lado GASTO (debe) — uno por consolidado (1 documento de Tesorería).
    rows.push({
      groupId: c.id,
      side: "GASTO",
      fecha: tm.fecha.toISOString(),
      rubro: rubroGasto,
      rubroLabel: labelByRubro.get(rubroGasto ?? -1) ?? null,
      detalle: detalleGasto,
      cuenta: tm.sucursalName,
      glosa: tm.glosa,
      counterparty,
      debe: absTm.toString(),
      haber: null,
      status: c.status,
      egresoExternalId: tm.externalId.toString(),
      bankMovementId: null,
    });
    totalDebe += absTm;

    // Lado(s) BANCO (haber) — uno por cada cartola vinculada.
    for (const l of c.links) {
      const bm = l.bankMovement;
      const linkAmount = l.amountAllocated ?? bm.amount;
      const bmAbs = linkAmount < 0n ? -linkAmount : linkAmount;
      // Cascada del rubro banco: override manual del Consolidado → enlace
      // cuenta→rubro (Configuración → Rubros, vía resolver) → rubroBanco
      // que vino de Tesorería.
      const rubroBanco =
        c.overrideRubroBanco ?? rubroByAccount.get(bm.accountId) ?? tm.rubroBanco;
      rows.push({
        groupId: c.id,
        side: "BANCO",
        fecha: bm.postDate.toISOString(),
        rubro: rubroBanco,
        rubroLabel: rubroBanco !== null ? labelByRubro.get(rubroBanco) ?? null : null,
        detalle: `${bm.account.bankName} ${bm.account.holderName}`,
        cuenta: bm.account.displayNumber || bm.account.accountNumber,
        glosa: bm.counterpartyName || bm.description || "",
        counterparty: bm.counterpartyName || counterparty,
        debe: null,
        haber: bmAbs.toString(),
        status: c.status,
        egresoExternalId: tm.externalId.toString(),
        bankMovementId: bm.id,
      });
      totalHaber += bmAbs;
    }
  }

  // Facets: cuentas presentes.
  const accSet = new Map<string, string>();
  for (const c of concs) {
    for (const l of c.links) {
      const a = l.bankMovement.account;
      accSet.set(a.id, `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`);
    }
  }

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: { debe: totalDebe.toString(), haber: totalHaber.toString() },
    facets: {
      accounts: [...accSet.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    },
  });
}

function parseRange(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  const parse = (s: string | null) => {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0) : null;
  };
  const from = parse(fromRaw);
  const to = parse(toRaw);
  if (from && to) {
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 1);
    return { from, to: toEnd };
  }
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  };
}
