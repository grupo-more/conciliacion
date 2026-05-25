import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runSync, syncDynatechIfStale } from "@/lib/dynatech/sync";
import { runMatching } from "@/lib/reconciliation/match";

/**
 * POST /api/dynatech/sync
 *
 * Por default ejecuta un sync "stale" (solo si el último OK fue hace >30s).
 * Con `?force=1`, ejecuta siempre.
 *
 * Después de un sync con movimientos nuevos, dispara el matching de conciliación
 * para procesar los Dynatechs recién traídos.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const result = force ? await runSync() : await syncDynatechIfStale(30);
  if (result === null) {
    return NextResponse.json({
      skipped: true,
      reason: "Último sync fue hace menos de 30 segundos",
    });
  }
  if (!result.ok) {
    return NextResponse.json(
      { ...result },
      { status: 502 } // bad gateway: la API externa falló
    );
  }

  // Si llegaron movimientos nuevos, intentar conciliarlos automáticamente
  if (result.insertedRows > 0) {
    try {
      await runMatching({ reEvaluateOpenStates: false });
    } catch (e) {
      console.error("[dynatech/sync] error en runMatching:", e);
    }
  }

  return NextResponse.json(result);
}
