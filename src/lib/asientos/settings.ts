import { prisma } from "@/lib/db";

export const ASIENTO_SETTINGS_ID = "default";

export interface AsientoSettings {
  /** Tasa de retención de honorarios vigente, en % (ej. 13.75). */
  retencionTasa: number;
  /** Rubro contable destino de la retención (default 26). */
  retencionRubro: number;
}

/** Lee el row de settings (lo crea si falta; la migración lo seedea). */
export async function getAsientoSettings(): Promise<AsientoSettings> {
  let row = await prisma.asientoManualSettings.findUnique({
    where: { id: ASIENTO_SETTINGS_ID },
  });
  if (!row) {
    row = await prisma.asientoManualSettings.create({
      data: { id: ASIENTO_SETTINGS_ID },
    });
  }
  return {
    retencionTasa: Number(row.retencionTasa),
    retencionRubro: row.retencionRubro,
  };
}
