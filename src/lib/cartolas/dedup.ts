import type { NormalizedMovement } from "./types";
import { normalizeDescription, shortHash } from "./normalize";

/**
 * Calcula la clave de deduplicación para cada movimiento del archivo.
 *
 * Estrategia: hash determinístico de (postDate, amount, externalId, descripción
 * normalizada, contraparte) + ordinal-por-fila para garantizar unicidad incluso
 * cuando el banco repite el N° de documento entre filas o emite movimientos
 * idénticos el mismo día.
 *
 * El ordinal se asigna según el orden de aparición en el archivo. Es estable
 * entre re-importaciones porque el banco no reordena filas idénticas del mismo
 * día entre exportaciones distintas.
 *
 * `externalId` queda como columna informativa (con su propio índice en BD)
 * pero NO se usa como clave única, porque algunos bancos lo reciclan.
 */
export function computeDedupKeys(movements: NormalizedMovement[]): string[] {
  const counters = new Map<string, number>();
  const keys: string[] = [];

  for (const m of movements) {
    const dayIso = m.postDate.toISOString().slice(0, 10);
    const baseInput = [
      dayIso,
      String(m.amount),
      m.externalId ?? "",
      normalizeDescription(m.description),
      m.counterpartyRut ?? "",
      m.counterpartyAccount ?? "",
    ].join("|");

    const baseHash = shortHash(baseInput);
    const seen = counters.get(baseHash) ?? 0;
    counters.set(baseHash, seen + 1);
    keys.push(`${baseHash}:${seen}`);
  }

  return keys;
}
