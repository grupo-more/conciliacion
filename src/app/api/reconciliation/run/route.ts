import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runMatching } from "@/lib/reconciliation/match";

/**
 * POST /api/reconciliation/run
 * Ejecuta el motor de matching sobre Dynatechs no procesados o en estados
 * "abiertos" (NO_MATCH, REVIEW). No toca AUTO_MATCHED, SUGGESTED, MANUAL ni
 * OUT_OF_SCOPE.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const result = await runMatching({ reEvaluateOpenStates: true });
  return NextResponse.json(result);
}
