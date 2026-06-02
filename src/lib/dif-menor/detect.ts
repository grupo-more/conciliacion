/**
 * Detección de "diferencias menores" en cartolas bancarias.
 *
 * Patrón: clientes que hacen transferencias chicas (de $1, $50, $100) como
 * prueba para verificar que están usando la cuenta correcta antes de mandar
 * la transferencia real. Esa plata entra al banco como un IN pero NO tiene
 * contraparte en Tesorería (no es una venta), así que queda eternamente
 * "sin matchear" y ensucia la conciliación.
 *
 * El módulo "Dif menor a 100" arma un asiento contable directo:
 *   Debe rubro de la cuenta (inferido del nombre del catálogo)
 *   Haber rubro 2050 (diferencia, configurable)
 *
 * El umbral (default 100, inclusivo) y el rubro destino son editables desde
 * Configuración → tab "Dif menor a 100".
 */

import { prisma } from "@/lib/db";

export const DIF_MENOR_SETTINGS_ID = "default";

export interface DifMenorSettings {
  threshold: number;
  rubroDiferencia: number;
}

/**
 * Lee el setting global. Si por algún motivo no existe el row (debería estar
 * seedeado por la migración), devuelve los defaults.
 */
export async function getDifMenorSettings(): Promise<DifMenorSettings> {
  const row = await prisma.difMenorSettings.findUnique({
    where: { id: DIF_MENOR_SETTINGS_ID },
  });
  if (!row) return { threshold: 100, rubroDiferencia: 2050 };
  return {
    threshold: row.threshold,
    rubroDiferencia: row.rubroDiferencia,
  };
}

/**
 * Predicado JS puro: el movimiento es candidato a "dif menor".
 * Solo aplica a abonos IN cuyo monto absoluto está dentro del umbral.
 */
export function isDifMenor(
  m: { amount: bigint; direction: string },
  threshold: number
): boolean {
  if (m.direction !== "IN") return false;
  const abs = m.amount < 0n ? -m.amount : m.amount;
  return abs <= BigInt(threshold);
}

/**
 * Infiere el rubro contable de una cuenta bancaria a partir del catálogo
 * de RubroLabels: busca un rubro cuyo `name` matchee con `bankName + holderName`
 * de la cuenta (normalizado). Estrategia:
 *   1) Igualdad exacta (normalizada)
 *   2) Contains en cualquier dirección (mínimo 3 caracteres)
 *
 * Excluye los rubros marcados como isDifference=true (esos son para
 * destinos de ajuste, no para representar una cuenta bancaria).
 *
 * Devuelve un Map<accountId, rubro>. Si una cuenta no matchea, no aparece
 * en el Map (queda sin rubro, el endpoint lo refleja como null).
 */
export async function inferRubroByAccount(
  accountIds: string[]
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;

  const [accounts, rubros] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, bankName: true, holderName: true },
    }),
    prisma.rubroLabel.findMany({
      where: { isDifference: false },
      select: { rubro: true, name: true },
    }),
  ]);

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const acc of accounts) {
    const accKey = norm(`${acc.bankName} ${acc.holderName}`);
    const exact = rubros.find((r) => norm(r.name) === accKey);
    if (exact) {
      result.set(acc.id, exact.rubro);
      continue;
    }
    const partial = rubros.find((r) => {
      const rn = norm(r.name);
      return rn.length >= 3 && (accKey.includes(rn) || rn.includes(accKey));
    });
    if (partial) result.set(acc.id, partial.rubro);
  }

  return result;
}
