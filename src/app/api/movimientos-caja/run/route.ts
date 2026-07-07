import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runMatchMovimientos } from "@/lib/movimientos/match-movimientos";
import { denyUnless } from "@/lib/perms";

/**
 * POST /api/movimientos-caja/run
 * Recalcula el cruce MovimientoCaja ↔ cartola (sin re-sincronizar el feed).
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "reevaluar");
  if (deniedPerm) return deniedPerm;

  const match = await runMatchMovimientos();
  if (!match.ok) return NextResponse.json({ match }, { status: 500 });
  return NextResponse.json({ match });
}
