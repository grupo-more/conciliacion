import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  computeAccountBalances,
  computeAlerts,
  computeFlows,
  computeKPIs,
  computePipeline,
  computeTopBranches,
  computeTopCashiers,
  getPeriodRange,
  type Period,
} from "@/lib/dashboard/queries";

/**
 * GET /api/dashboard?period=day|week|month
 *
 * Devuelve todo el resumen del dashboard en una sola llamada.
 * - kpis: 4 métricas principales con variación vs período anterior
 * - balances: cuentas con saldo, freshness, ingresos conciliados/otros
 * - pipeline: estados de conciliación + backlog
 * - flows: serie diaria (in/out/net + saldo running)
 * - topBranches / topCashiers: rankings del período
 * - alerts: atenciones que requieren acción
 */
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

  const range = getPeriodRange(period);

  const [kpis, balances, pipeline, flows, topBranches, topCashiers, alerts] =
    await Promise.all([
      computeKPIs(range),
      computeAccountBalances(range, range.end),
      computePipeline(range),
      computeFlows(range),
      computeTopBranches(range),
      computeTopCashiers(range),
      computeAlerts(),
    ]);

  return NextResponse.json({
    period,
    range: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      prevStart: range.prevStart.toISOString(),
      prevEnd: range.prevEnd.toISOString(),
      label: range.label,
    },
    kpis,
    balances,
    pipeline,
    flows,
    topBranches,
    topCashiers,
    alerts,
    generatedAt: new Date().toISOString(),
  });
}
