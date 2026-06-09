import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { parseRange } from "@/lib/reportes/classify";
import {
  computeBancoSinConciliar,
  type BancoFilters,
} from "@/lib/reportes/banco-compute";
import type { BankTag } from "@/lib/reportes/classify";

/**
 * GET /api/reportes/banco-sin-conciliar
 *   ?from&to&accountId&direction=IN|OUT&tag=interno|transbank|comision|sin_clasificar
 *
 * Movimientos de cartola (BankMovement) que son brecha real de conciliación.
 * Se excluyen los resueltos por otra vía (motor, Abono Transbank, pares de
 * Traspasos internos) — ver lib/reportes/banco-compute.ts. Cada fila trae tag
 * (interno/transbank/comision/sin_clasificar) y aging.
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
  const filters: BancoFilters = {
    accountId: url.searchParams.get("accountId") || null,
    direction: url.searchParams.get("direction"),
    tag: (url.searchParams.get("tag") as BankTag | null) || null,
  };

  const result = await computeBancoSinConciliar(from, to, filters);

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    ...result,
  });
}
