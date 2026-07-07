import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ASIENTO_SETTINGS_ID, getAsientoSettings } from "@/lib/asientos/settings";
import { denyUnless } from "@/lib/perms";

/**
 * GET   /api/asientos-settings → tasa de retención de honorarios + rubro destino.
 * PATCH /api/asientos-settings → actualiza tasa y/o rubro.
 *
 * Usado por el módulo "Asientos manuales": la tasa varía por año, por eso es
 * editable; el rubro de la retención casi siempre es el mismo (default 26).
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  return NextResponse.json(await getAsientoSettings());
}

const patchSchema = z.object({
  retencionTasa: z.number().min(0).max(100).optional(),
  retencionRubro: z.number().int().positive().optional(),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { retencionTasa, retencionRubro } = parsed.data;

  if (retencionRubro !== undefined) {
    const exists = await prisma.rubroLabel.findUnique({
      where: { rubro: retencionRubro },
      select: { rubro: true },
    });
    if (!exists) {
      return NextResponse.json(
        { error: `El rubro ${retencionRubro} no existe` },
        { status: 400 },
      );
    }
  }

  const updated = await prisma.asientoManualSettings.upsert({
    where: { id: ASIENTO_SETTINGS_ID },
    update: {
      ...(retencionTasa !== undefined ? { retencionTasa } : {}),
      ...(retencionRubro !== undefined ? { retencionRubro } : {}),
    },
    create: {
      id: ASIENTO_SETTINGS_ID,
      ...(retencionTasa !== undefined ? { retencionTasa } : {}),
      ...(retencionRubro !== undefined ? { retencionRubro } : {}),
    },
  });

  return NextResponse.json({
    retencionTasa: Number(updated.retencionTasa),
    retencionRubro: updated.retencionRubro,
  });
}
