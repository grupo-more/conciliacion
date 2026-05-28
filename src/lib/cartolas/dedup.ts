import type { NormalizedMovement } from "./types";
import { normalizeDescription, shortHash } from "./normalize";

/**
 * Extrae el número de referencia que muchos bancos (especialmente Santander)
 * incluyen al INICIO de la descripción. Ese número es el ID real de la
 * transacción y se mantiene IGUAL entre distintos formatos de cartola del
 * mismo banco — por eso es la mejor señal de dedup cuando esta presente.
 *
 *   "0130195822 Transf. BAEZ FIGUEROA C"              -> "0130195822"
 *   "0130195822 Transf. BAEZ FIGUEROA CLAUDIO ANDRES" -> "0130195822"
 *   "Transferencia recibida de SUSANA"                -> ""
 *
 * Acepta secuencias >= 6 digitos para minimizar falsos positivos (ej. evita
 * confundir un monto pequeño con una referencia).
 */
export function extractEmbeddedReference(description: string): string {
  const m = description.trim().match(/^\s*(\d{6,})/);
  return m ? m[1] : "";
}

/**
 * Calcula la clave de deduplicación para cada movimiento del archivo.
 *
 * Estrategia en tres niveles, de más fuerte a más débil:
 *
 *   1. REF: referencia embebida al inicio de la descripción (típico Santander)
 *      → dedupKey = (day | amount | ref). La descripción NO entra porque
 *      distintos formatos del mismo banco truncan/expanden el nombre del
 *      cliente y esa variación no debe romper el dedup.
 *
 *   2. EXT: cuando el banco entrega un `externalId` (ej. BCI "Código
 *      Transferencia") y no hay ref embebida → dedupKey = (day | amount |
 *      externalId). El externalId es el ID único de la transacción para ese
 *      banco; no depende del resto de campos. Esto resuelve el caso BCI
 *      donde counterparty_rut/counterparty_account a veces vienen y a veces
 *      no, generando hashes distintos para el mismo movimiento.
 *
 *   3. FULL (fallback): cuando NO hay ni ref ni externalId (ej. Banco
 *      Internacional sin N° doc) → hash completo de descripción + contraparte
 *      + amount + día.
 *
 * En todos los casos se agrega un ordinal-por-fila para sobrevivir el caso
 * de N transferencias idénticas el mismo día con el MISMO identificador
 * (raro pero posible — el banco las asigna como una sola transacción con
 * varias filas).
 */
export function computeDedupKeys(movements: NormalizedMovement[]): string[] {
  const counters = new Map<string, number>();
  const keys: string[] = [];

  for (const m of movements) {
    const dayIso = m.postDate.toISOString().slice(0, 10);
    const ref = extractEmbeddedReference(m.description);
    const ext = (m.externalId ?? "").trim();

    let baseInput: string;
    if (ref) {
      baseInput = ["REF", dayIso, String(m.amount), ref].join("|");
    } else if (ext) {
      baseInput = ["EXT", dayIso, String(m.amount), ext].join("|");
    } else {
      baseInput = [
        "FULL",
        dayIso,
        String(m.amount),
        normalizeDescription(m.description),
        m.counterpartyRut ?? "",
        m.counterpartyAccount ?? "",
      ].join("|");
    }

    const baseHash = shortHash(baseInput);
    const seen = counters.get(baseHash) ?? 0;
    counters.set(baseHash, seen + 1);
    keys.push(`${baseHash}:${seen}`);
  }

  return keys;
}
