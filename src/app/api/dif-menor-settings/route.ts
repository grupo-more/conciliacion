import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DIF_MENOR_SETTINGS_ID } from "@/lib/dif-menor/detect";
import { denyUnless } from "@/lib/perms";

/**
 * GET  /api/dif-menor-settings → devuelve el setting actual (1 row).
 * PATCH /api/dif-menor-settings → actualiza threshold, rubroDiferencia y/o
 *        rubroComision.
 *
 * El módulo "Diferencias y comisiones" usa este setting para decidir qué
 * movimientos son diferencias chicas / comisiones bancarias y a qué rubros
 * contables los manda en el asiento.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  let row = await prisma.difMenorSettings.findUnique({
    where: { id: DIF_MENOR_SETTINGS_ID },
  });
  // Crear el row default si no existe (defensivo; la migración lo seedea).
  if (!row) {
    row = await prisma.difMenorSettings.create({
      data: { id: DIF_MENOR_SETTINGS_ID },
    });
  }

  return NextResponse.json({
    threshold: row.threshold,
    rubroDiferencia: row.rubroDiferencia,
    rubroComision: row.rubroComision,
    updatedAt: row.updatedAt.toISOString(),
  });
}

const patchSchema = z.object({
  threshold: z.number().int().positive().max(100_000_000).optional(),
  rubroDiferencia: z.number().int().positive().optional(),
  rubroComision: z.number().int().positive().optional(),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 }
    );
  }

  const { threshold, rubroDiferencia, rubroComision } = parsed.data;

  // Validar que los rubros existan en RubroLabel (si se pasaron).
  for (const rubro of [rubroDiferencia, rubroComision]) {
    if (rubro === undefined) continue;
    const exists = await prisma.rubroLabel.findUnique({
      where: { rubro },
      select: { rubro: true },
    });
    if (!exists) {
      return NextResponse.json({ error: `El rubro ${rubro} no existe` }, { status: 400 });
    }
  }

  const cambios = {
    ...(threshold !== undefined ? { threshold } : {}),
    ...(rubroDiferencia !== undefined ? { rubroDiferencia } : {}),
    ...(rubroComision !== undefined ? { rubroComision } : {}),
  };
  const updated = await prisma.difMenorSettings.upsert({
    where: { id: DIF_MENOR_SETTINGS_ID },
    update: cambios,
    create: { id: DIF_MENOR_SETTINGS_ID, ...cambios },
  });

  return NextResponse.json({
    threshold: updated.threshold,
    rubroDiferencia: updated.rubroDiferencia,
    rubroComision: updated.rubroComision,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
