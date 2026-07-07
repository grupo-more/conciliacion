import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runMovimientosSync } from "@/lib/movimientos/sync-movimientos";
import { runMatchMovimientos } from "@/lib/movimientos/match-movimientos";
import { denyUnless } from "@/lib/perms";

/**
 * POST /api/movimientos-caja/sync
 *
 * Ingiere el feed /api/movimientos (CAJA_BANCO + BANCO_BANCO) y luego corre el
 * matcher contra la cartola. Con ?onlySync=1 solo ingiere (no cruza).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "importar");
  if (deniedPerm) return deniedPerm;

  const onlySync = new URL(req.url).searchParams.get("onlySync") === "1";

  const sync = await runMovimientosSync();
  if (!sync.ok) return NextResponse.json({ sync }, { status: 502 });

  const match = onlySync ? null : await runMatchMovimientos();
  return NextResponse.json({ sync, match });
}
