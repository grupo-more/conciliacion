import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/consolidados/egresos-terceros/asiento?from&to&accountId
 *
 * Asiento contable (partida doble) de los egresos a terceros CONCILIADOS
 * (EgresoConciliacion AUTO_MATCHED | MANUAL) — raíz banco / destino gasto:
 *   DEBE  = rubro del gasto operativo (EgresoMovement)
 *   HABER = cuenta banco (BankMovement OUT)
 * Análogo a OK / Abono Transbank.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const accountId = url.searchParams.get("accountId") || null;

  const concs = await prisma.egresoConciliacion.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      egresoMovement: { fecha: { gte: from, lt: to } },
    },
    include: {
      egresoMovement: true,
      links: { include: { bankMovement: { include: { account: true } } } },
    },
    orderBy: { egresoMovement: { fecha: "desc" } },
  });

  type Row = {
    groupId: string;
    side: "GASTO" | "BANCO";
    fecha: string;
    rubro: number | null;
    rubroLabel: string | null;
    detalle: string;
    cuenta: string | null;
    glosa: string;
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
    const links = c.links;
    if (links.length === 0) continue;
    // Filtro por cuenta: si se pidió, solo asientos cuyo banco está en esa cuenta.
    if (accountId && !links.some((l) => l.bankMovement.accountId === accountId)) continue;

    const e = c.egresoMovement;
    const abs = e.monto < 0n ? -e.monto : e.monto;
    const fecha = e.fecha.toISOString();

    // Lado GASTO (debe).
    rows.push({
      groupId: c.id,
      side: "GASTO",
      fecha,
      rubro: e.rubroId,
      rubroLabel: e.rubroNombre,
      detalle: e.rubroNombre ?? "Gasto",
      cuenta: e.sucursalName,
      glosa: e.glosa,
      debe: abs.toString(),
      haber: null,
      status: c.status,
      egresoExternalId: e.externalId.toString(),
      bankMovementId: null,
    });
    totalDebe += abs;

    // Lado(s) BANCO (haber) — uno por movimiento vinculado.
    for (const l of links) {
      const bm = l.bankMovement;
      const bmAbs = bm.amount < 0n ? -bm.amount : bm.amount;
      rows.push({
        groupId: c.id,
        side: "BANCO",
        fecha: bm.postDate.toISOString(),
        rubro: null,
        rubroLabel: null,
        detalle: `${bm.account.bankName} ${bm.account.holderName}`,
        cuenta: bm.account.displayNumber || bm.account.accountNumber,
        glosa: bm.counterpartyName || bm.description || "",
        debe: null,
        haber: bmAbs.toString(),
        status: c.status,
        egresoExternalId: e.externalId.toString(),
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
