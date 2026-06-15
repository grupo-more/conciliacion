import { prisma } from "@/lib/db";

export const CUADRATURA_SETTINGS_ID = "default";

export interface CuadraturaSettings {
  /** Rubro de ventas/ingreso (HABER). Default 17. */
  rubroVentas: number;
  /** Rubro Tesorería (DEBE, total abono neto). Default 200. */
  rubroTesoreria: number;
  /** Rubro comisión Transbank (DEBE, gasto). Default 708. */
  rubroComision: number;
  /** Rubro diferencia/ajuste de cuadratura (tapón). Default 1403. */
  rubroDiferencia: number;
}

/** Lee el row de settings (lo crea si falta; la migración lo seedea). */
export async function getCuadraturaSettings(): Promise<CuadraturaSettings> {
  let row = await prisma.cuadraturaTransbankSettings.findUnique({
    where: { id: CUADRATURA_SETTINGS_ID },
  });
  if (!row) {
    row = await prisma.cuadraturaTransbankSettings.create({
      data: { id: CUADRATURA_SETTINGS_ID },
    });
  }
  return {
    rubroVentas: row.rubroVentas,
    rubroTesoreria: row.rubroTesoreria,
    rubroComision: row.rubroComision,
    rubroDiferencia: row.rubroDiferencia,
  };
}
