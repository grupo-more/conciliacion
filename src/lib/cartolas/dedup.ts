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
 * Estrategia en dos niveles:
 *
 *   1. SEÑAL FUERTE: si encontramos una referencia embebida al inicio de la
 *      descripción (típico Santander), dedupKey = (day | amount | ref).
 *      No incluye el resto de la descripción porque distintos formatos del
 *      mismo banco pueden truncar/expandir el nombre del cliente — esa
 *      variación NO debe romper el dedup.
 *
 *   2. SEÑAL DÉBIL (fallback): cuando no hay referencia embebida (ej. Banco
 *      Internacional, BCI sin N° doc, etc.) usamos el hash completo de
 *      descripción + contraparte + amount + día + ordinal, como antes.
 *
 * En ambos casos se agrega un ordinal-por-fila para sobrevivir el caso de
 * 5 transferencias idénticas el mismo día con la MISMA referencia (raro pero
 * posible — el banco las asigna como una sola transacción con varias filas).
 */
export function computeDedupKeys(movements: NormalizedMovement[]): string[] {
  const counters = new Map<string, number>();
  const keys: string[] = [];

  for (const m of movements) {
    const dayIso = m.postDate.toISOString().slice(0, 10);
    const ref = extractEmbeddedReference(m.description);

    let baseInput: string;
    if (ref) {
      // Señal fuerte: ID embebido + monto + día. La descripción no entra.
      baseInput = ["REF", dayIso, String(m.amount), ref].join("|");
    } else {
      // Fallback al algoritmo anterior (con descripción y contraparte).
      baseInput = [
        "FULL",
        dayIso,
        String(m.amount),
        m.externalId ?? "",
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
