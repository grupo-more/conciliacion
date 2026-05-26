import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runTesoreriaSync, syncTesoreriaIfStale } from "@/lib/tesoreria/sync";

/**
 * POST /api/tesoreria/sync
 *
 * Por default ejecuta un sync "stale" (solo si el ultimo OK fue hace >30s).
 * Con `?force=1`, ejecuta siempre.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const result = force ? await runTesoreriaSync() : await syncTesoreriaIfStale(30);
  if (result === null) {
    return NextResponse.json({
      skipped: true,
      reason: "Ultimo sync fue hace menos de 30 segundos",
    });
  }
  if (!result.ok) {
    return NextResponse.json({ ...result }, { status: 502 });
  }
  return NextResponse.json(result);
}
