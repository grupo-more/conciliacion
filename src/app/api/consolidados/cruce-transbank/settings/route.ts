import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { CUADRATURA_SETTINGS_ID, getCuadraturaSettings } from "@/lib/cuadratura/settings";
import { denyUnless } from "@/lib/perms";

/**
 * GET/PUT de los 4 rubros del asiento de cuadratura Transbank
 * (ventas 17 / tesorería 200 / comisión 708 / diferencia 1403).
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  return NextResponse.json(await getCuadraturaSettings());
}

const putSchema = z.object({
  rubroVentas: z.number().int().min(0).max(999999),
  rubroTesoreria: z.number().int().min(0).max(999999),
  rubroComision: z.number().int().min(0).max(999999),
  rubroDiferencia: z.number().int().min(0).max(999999),
});

export async function PUT(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }

  const row = await prisma.cuadraturaTransbankSettings.upsert({
    where: { id: CUADRATURA_SETTINGS_ID },
    create: { id: CUADRATURA_SETTINGS_ID, ...parsed.data },
    update: parsed.data,
  });

  return NextResponse.json({
    rubroVentas: row.rubroVentas,
    rubroTesoreria: row.rubroTesoreria,
    rubroComision: row.rubroComision,
    rubroDiferencia: row.rubroDiferencia,
  });
}
