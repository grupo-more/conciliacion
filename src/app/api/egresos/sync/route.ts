import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runEgresosSync } from "@/lib/egresos/sync-egresos";

/** POST /api/egresos/sync — sincroniza /api/egresos -> EgresoMovement. */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const result = await runEgresosSync();
  if (!result.ok) return NextResponse.json(result, { status: 502 });
  return NextResponse.json(result);
}
