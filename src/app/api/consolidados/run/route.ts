import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runConsolidados } from "@/lib/consolidados/match";

/**
 * POST /api/consolidados/run
 *
 * Body opcional: { reEvaluateOpen?: boolean, tesoreriaIds?: string[] }
 *
 * Por defecto procesa solo TesoreriaMovements sin Consolidado todavía.
 * Con reEvaluateOpen=true también re-evalúa los que están en estado
 * abierto (NO_MATCH / SUGGESTED / REVIEW). Útil después de subir cartolas
 * nuevas que pueden destrabar matches anteriores.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const reEvaluateOpen = body?.reEvaluateOpen === true;
  const tesoreriaIds = Array.isArray(body?.tesoreriaIds)
    ? (body.tesoreriaIds as string[]).filter((s) => typeof s === "string")
    : undefined;

  const result = await runConsolidados({ reEvaluateOpen, tesoreriaIds });
  return NextResponse.json(result);
}
