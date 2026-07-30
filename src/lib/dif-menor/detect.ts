/**
 * Detección del módulo "Diferencias y comisiones" (ex "Dif menor a 100").
 * Dos poblaciones de movimientos solo-banco que se resuelven con asiento
 * automático (nunca tendrán contraparte en Tesorería):
 *
 * 1) DIFERENCIAS MENORES: transferencias chicas (|monto| ≤ umbral) que los
 *    clientes hacen como prueba antes de mandar la transferencia real.
 *    Asiento: Debe rubro cuenta / Haber rubroDiferencia (2050); egresos
 *    invertido.
 *
 * 2) COMISIONES BANCARIAS: cargos del propio banco (comisión, mantención,
 *    impuesto, IVA, cobros) — OUT SIN contraparte cuya glosa matchea
 *    COMISION_RE. Asiento: Debe rubroComision (1503) / Haber rubro cuenta.
 *
 * Umbral y los dos rubros destino son editables desde Configuración →
 * "Diferencias y comisiones". Un OUT chico que matchea comisión se trata como
 * COMISIÓN (tiene prioridad sobre dif menor).
 */

import { prisma } from "@/lib/db";
import { COMISION_RE } from "@/lib/reportes/classify";

export const DIF_MENOR_SETTINGS_ID = "default";

export interface DifMenorSettings {
  threshold: number;
  rubroDiferencia: number;
  rubroComision: number;
}

/**
 * Lee el setting global. Si por algún motivo no existe el row (debería estar
 * seedeado por la migración), devuelve los defaults.
 */
export async function getDifMenorSettings(): Promise<DifMenorSettings> {
  const row = await prisma.difMenorSettings.findUnique({
    where: { id: DIF_MENOR_SETTINGS_ID },
  });
  if (!row) return { threshold: 100, rubroDiferencia: 2050, rubroComision: 1503 };
  return {
    threshold: row.threshold,
    rubroDiferencia: row.rubroDiferencia,
    rubroComision: row.rubroComision,
  };
}

/**
 * Predicado JS puro: el movimiento es una COMISIÓN/cargo del propio banco.
 * Solo cargos (OUT) SIN contraparte (las comisiones nunca traen RUT/nombre;
 * una transferencia real sí — es la salvaguarda contra falsos positivos del
 * patrón amplio) cuya glosa matchea COMISION_RE.
 */
export function isComisionBancaria(m: {
  direction: string;
  description: string | null;
  counterpartyRut?: string | null;
  counterpartyName?: string | null;
}): boolean {
  if (m.direction !== "OUT") return false;
  if ((m.counterpartyRut ?? "").trim() || (m.counterpartyName ?? "").trim()) return false;
  return COMISION_RE.test(m.description ?? "");
}

/**
 * Predicado JS puro: el movimiento es candidato a "dif menor".
 * Aplica en ambas direcciones: abonos IN (pruebas que entran) y cargos OUT
 * (pruebas que salen para validar una cuenta destino), siempre que el monto
 * absoluto esté dentro del umbral. Cada dirección tiene su propio asiento en
 * la tab "Dif menor a 100" (toggle Ingresos/Egresos).
 */
export function isDifMenor(
  m: { amount: bigint; direction: string },
  threshold: number
): boolean {
  if (m.direction !== "IN" && m.direction !== "OUT") return false;
  const abs = m.amount < 0n ? -m.amount : m.amount;
  return abs > 0n && abs <= BigInt(threshold);
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
