import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DIF_MENOR_SETTINGS_ID } from "@/lib/dif-menor/detect";
import { denyUnless } from "@/lib/perms";

/**
 * GET  /api/dif-menor-settings → devuelve el setting actual (1 row).
 * PATCH /api/dif-menor-settings → actualiza threshold y/o rubroDiferencia.
 *
 * El módulo "Dif menor a 100" usa este setting para decidir qué movimientos
 * son "diferencias chicas" y a qué rubro contable los manda en el asiento.
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
    updatedAt: row.updatedAt.toISOString(),
  });
}

const patchSchema = z.object({
  threshold: z.number().int().positive().max(100_000_000).optional(),
  rubroDiferencia: z.number().int().positive().optional(),
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

  const { threshold, rubroDiferencia } = parsed.data;

  // Validar que el rubro existe en RubroLabel (si se pasó).
  if (rubroDiferencia !== undefined) {
    const exists = await prisma.rubroLabel.findUnique({
      where: { rubro: rubroDiferencia },
      select: { rubro: true },
    });
    if (!exists) {
      return NextResponse.json(
        { error: `El rubro ${rubroDiferencia} no existe` },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.difMenorSettings.upsert({
    where: { id: DIF_MENOR_SETTINGS_ID },
    update: {
      ...(threshold !== undefined ? { threshold } : {}),
      ...(rubroDiferencia !== undefined ? { rubroDiferencia } : {}),
    },
    create: {
      id: DIF_MENOR_SETTINGS_ID,
      ...(threshold !== undefined ? { threshold } : {}),
      ...(rubroDiferencia !== undefined ? { rubroDiferencia } : {}),
    },
  });

  return NextResponse.json({
    threshold: updated.threshold,
    rubroDiferencia: updated.rubroDiferencia,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
