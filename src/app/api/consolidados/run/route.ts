import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runConsolidados } from "@/lib/consolidados/match";
import { runEgresosTerceros } from "@/lib/egresos/match-terceros";
import { runDynatechEgresosTerceros } from "@/lib/egresos/match-dynatech-terceros";

/**
 * POST /api/consolidados/run
 *
 * Body opcional: { dryRun?: boolean, preserveManual?: boolean }
 *
 * El motor V3 hace WIPE + REBUILD en cada corrida (la asignacion bipartita
 * global requiere considerar todos los pares posibles, no solo los abiertos).
 * Los Consolidados con status=MANUAL se preservan por defecto.
 *
 *  - dryRun=true: NO escribe en BD, solo devuelve el summary con lo que haria.
 *  - preserveManual=false: tambien re-evalua los MANUAL (cuidado).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const preserveManual = body?.preserveManual !== false; // default true

  const result = await runConsolidados({ dryRun, preserveManual });
  // Además, conciliar egresos a terceros (OUT banco ↔ EgresoMovement). Corre
  // después porque excluye del pool los OUT ya conciliados contra Tesorería.
  const egresos = await runEgresosTerceros({ dryRun, preserveManual });
  // Auto-match de egresos a terceros contra EGRESO de Dynatech (TesoreriaMovement).
  // Corre al final: auto-confirma solo los pares 1:1 únicos por monto+fecha que el
  // motor principal no pudo cerrar (cross-banco / sin banco resuelto).
  const egresosDynatech = await runDynatechEgresosTerceros({ dryRun });
  return NextResponse.json({ ...result, egresos, egresosDynatech });
}
