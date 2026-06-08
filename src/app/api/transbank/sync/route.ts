import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runTbkTesoreriaSync } from "@/lib/transbank/sync-tbk";

/**
 * POST /api/transbank/sync
 * Sincroniza el feed POS /api/tbk-tesoreria a la tabla TbkTesoreria.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const result = await runTbkTesoreriaSync();
  if (!result.ok) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
