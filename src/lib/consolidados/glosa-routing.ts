/**
 * Ruteo por glosa para movimientos de Tesorería SIN banco asignado.
 *
 * Algunos movimientos llegan de la API con `banco = null` (no traen el banco
 * destino), pero se sabe por la glosa a qué cuenta corresponden y contra qué
 * contraparte deben cuadrar. Sin esto caen en OUT_OF_SCOPE y nunca matchean.
 *
 * Caso actual (jun-2026): las liquidaciones CRYPTOMKT. La plata entra/sale por
 * la cuenta Santander MG SPA y la contraparte bancaria es "CRYPTOMKT SPA".
 * Se resuelve la cuenta vía el alias que el usuario ya configuró ("Santander
 * MG") y se restringe el match a movimientos cuya contraparte/descripción
 * contenga el marcador, para no agarrar cualquier movimiento del mismo monto.
 *
 * Centralizado acá (igual que cuentas/uso-parcial) para extenderlo sin tocar
 * el motor. A futuro se puede migrar a una tabla configurable por UI.
 */

export interface GlosaRoute {
  /** Substring (mayúsculas) que debe contener la glosa del TM. */
  glosaMarker: string;
  /** Alias de banco existente (bancoString de BankAccountAlias) que resuelve
   *  la cuenta destino. Reusa la config que el usuario ya tiene cargada. */
  viaAlias: string;
  /** Substring (mayúsculas) que debe contener counterpartyName/description del
   *  movimiento bancario candidato. Evita falsos positivos por monto. */
  counterpartyMarker: string;
}

const ROUTES: GlosaRoute[] = [
  {
    glosaMarker: "CRYPTOM",
    viaAlias: "Santander MG",
    counterpartyMarker: "CRYPTOM",
  },
];

/** Devuelve la ruta cuya glosaMarker está contenida en la glosa, o null. */
export function matchGlosaRoute(glosa: string | null | undefined): GlosaRoute | null {
  const g = (glosa ?? "").toUpperCase();
  if (!g) return null;
  return ROUTES.find((r) => g.includes(r.glosaMarker)) ?? null;
}

/** True si el movimiento bancario matchea el marcador de contraparte. */
export function bmMatchesMarker(
  bm: { counterpartyName?: string | null; description?: string | null },
  marker: string,
): boolean {
  const hay = `${bm.counterpartyName ?? ""} ${bm.description ?? ""}`.toUpperCase();
  return hay.includes(marker);
}
