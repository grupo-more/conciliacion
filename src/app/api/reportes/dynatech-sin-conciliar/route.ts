import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { parseRange } from "@/lib/reportes/classify";
import { computeDynatechSinConciliar } from "@/lib/reportes/dynatech-compute";
import type { DynatechMotivo } from "@/lib/reportes/classify";

/**
 * GET /api/reportes/dynatech-sin-conciliar
 *   ?from&to&banco&tipo=INGRESO|EGRESO&motivo=<DynatechMotivo>
 *
 * Movimientos de Dynatech (TesoreriaMovement) SIN contraparte conciliada en
 * banco: su Consolidado no es AUTO_MATCHED/MANUAL (incluye los que no tienen
 * Consolidado). Cada fila trae el MOTIVO (sin procesar / sugerido / revisar /
 * excepcion / sin match / fuera de scope) y su antiguedad.
 *
 * El cómputo vive en lib/reportes/dynatech-compute.ts, compartido con la
 * Auditoría de cuadre (/api/reportes/auditoria-cuadre).
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
  const banco = url.searchParams.get("banco") || null;
  const tipo = url.searchParams.get("tipo");
  const motivo = (url.searchParams.get("motivo") as DynatechMotivo | null) || null;

  const result = await computeDynatechSinConciliar(from, to, { banco, tipo, motivo });

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    ...result,
  });
}
