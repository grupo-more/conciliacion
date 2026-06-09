import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseRange, CONCILIADO_STATUSES } from "@/lib/reportes/classify";
import { computeBancoSinConciliar } from "@/lib/reportes/banco-compute";

/**
 * GET /api/reportes/overview?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Resumen cruzado de la brecha de conciliacion en el rango: cuanto hay sin
 * conciliar por cada lado (banco vs Dynatech), para la franja del modulo.
 *
 * Sin conciliar:
 *   - Banco: brecha real (excluye motor + Abono Transbank + pares de Traspasos
 *     internos) — mismo computo que el detalle, via computeBancoSinConciliar.
 *   - Dynatech: TesoreriaMovement cuyo Consolidado no es AUTO_MATCHED/MANUAL
 *     (incluye los que no tienen Consolidado).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );

  const conciliado = [...CONCILIADO_STATUSES];

  const [bancoResult, dynByTipo] = await Promise.all([
    // Mismo computo que el detalle (consistencia franja ↔ tab).
    computeBancoSinConciliar(from, to),
    prisma.tesoreriaMovement.groupBy({
      by: ["tipoOperacion"],
      where: {
        fecha: { gte: from, lt: to },
        NOT: { consolidado: { status: { in: conciliado } } },
      },
      _count: { _all: true },
      _sum: { monto: true },
    }),
  ]);

  const banco = {
    in: bancoResult.resumen.porDireccion.IN ?? { count: 0, monto: "0" },
    out: bancoResult.resumen.porDireccion.OUT ?? { count: 0, monto: "0" },
  };
  const bancoCount = bancoResult.resumen.count;
  const bancoMontoAbs = BigInt(bancoResult.resumen.monto);

  // Dynatech: INGRESO positivo, EGRESO negativo → monto absoluto.
  let dynCount = 0;
  let dynMontoAbs = 0n;
  const dynatech = {
    ingreso: { count: 0, monto: "0" },
    egreso: { count: 0, monto: "0" },
  };
  for (const g of dynByTipo) {
    const c = g._count._all;
    const s = g._sum.monto ?? 0n;
    dynCount += c;
    dynMontoAbs += s < 0n ? -s : s;
    if (g.tipoOperacion === "EGRESO")
      dynatech.egreso = { count: c, monto: (s < 0n ? -s : s).toString() };
    else dynatech.ingreso = { count: c, monto: (s < 0n ? -s : s).toString() };
  }

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    banco: {
      count: bancoCount,
      monto: bancoMontoAbs.toString(),
      ...banco,
    },
    dynatech: {
      count: dynCount,
      monto: dynMontoAbs.toString(),
      ...dynatech,
    },
  });
}
