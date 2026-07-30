import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ABONO_CONCILIADO_SETTINGS_ID } from "@/lib/transbank/abono-conciliado";
import { denyUnless } from "@/lib/perms";

/**
 * GET   /api/abono-conciliado-settings → rubros actuales del asiento (1 row).
 * PATCH /api/abono-conciliado-settings → actualiza rubroDebe y/o rubroHaber.
 *
 * Usados por Cruce Transbank → "Abonos conciliados": abonos/cargos de Transbank
 * sin operación de la empresa asociada, contabilizados Debe rubroDebe / Haber
 * rubroHaber (neto).
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  let row = await prisma.abonoConciliadoSettings.findUnique({
    where: { id: ABONO_CONCILIADO_SETTINGS_ID },
  });
  // Crear el row default si no existe (defensivo; la migración lo seedea).
  if (!row) {
    row = await prisma.abonoConciliadoSettings.create({
      data: { id: ABONO_CONCILIADO_SETTINGS_ID },
    });
  }

  return NextResponse.json({
    rubroDebe: row.rubroDebe,
    rubroHaber: row.rubroHaber,
    updatedAt: row.updatedAt.toISOString(),
  });
}

const patchSchema = z.object({
  rubroDebe: z.number().int().positive().optional(),
  rubroHaber: z.number().int().positive().optional(),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { rubroDebe, rubroHaber } = parsed.data;

  // Validar que los rubros existan en el catálogo.
  for (const rubro of [rubroDebe, rubroHaber]) {
    if (rubro === undefined) continue;
    const exists = await prisma.rubroLabel.findUnique({
      where: { rubro },
      select: { rubro: true },
    });
    if (!exists) {
      return NextResponse.json({ error: `El rubro ${rubro} no existe` }, { status: 400 });
    }
  }

  const updated = await prisma.abonoConciliadoSettings.upsert({
    where: { id: ABONO_CONCILIADO_SETTINGS_ID },
    update: {
      ...(rubroDebe !== undefined ? { rubroDebe } : {}),
      ...(rubroHaber !== undefined ? { rubroHaber } : {}),
    },
    create: {
      id: ABONO_CONCILIADO_SETTINGS_ID,
      ...(rubroDebe !== undefined ? { rubroDebe } : {}),
      ...(rubroHaber !== undefined ? { rubroHaber } : {}),
    },
  });

  return NextResponse.json({
    rubroDebe: updated.rubroDebe,
    rubroHaber: updated.rubroHaber,
    updatedAt: updated.updatedAt.toISOString(),
  });
}
