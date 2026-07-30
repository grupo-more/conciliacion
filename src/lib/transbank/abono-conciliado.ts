import { prisma } from "@/lib/db";

/**
 * Settings de "Abonos conciliados" (Cruce Transbank): abonos/cargos de
 * Transbank ajenos a la operación de la empresa (jamás tendrán POS). Se
 * identifican a mano y se contabilizan directo por el NETO (totalAbono):
 *   Debe rubroDebe (default 200) / Haber rubroHaber (default 1403)
 * El monto va tal cual (un cargo queda negativo en el asiento, no se invierte).
 * Ambos rubros son editables desde Configuración → Abonos Transbank.
 */

export const ABONO_CONCILIADO_SETTINGS_ID = "default";

export interface AbonoConciliadoSettings {
  rubroDebe: number;
  rubroHaber: number;
}

export async function getAbonoConciliadoSettings(): Promise<AbonoConciliadoSettings> {
  const row = await prisma.abonoConciliadoSettings.findUnique({
    where: { id: ABONO_CONCILIADO_SETTINGS_ID },
  });
  if (!row) return { rubroDebe: 200, rubroHaber: 1403 };
  return { rubroDebe: row.rubroDebe, rubroHaber: row.rubroHaber };
}
