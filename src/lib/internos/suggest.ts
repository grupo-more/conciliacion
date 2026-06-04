/**
 * Sugiere una EntidadInterna a partir de un nombre de titular libre.
 *
 * Misma logica que scripts/fix-holder-rut.ts pero pensada para correr inline
 * en server (al previsualizar un import de cartola, por ejemplo). El proposito
 * es que cuando el operador decida "crear cuenta nueva" para una cartola
 * recien subida, el formulario venga pre-rellenado con el holderRut correcto.
 *
 * Match heuristico: normaliza ambos lados (lowercase, sin puntos, sin guiones)
 * y comprueba inclusion bidireccional contra el nombre canonico y los aliases.
 * Si matchea varios entes, devuelve null y los lista en `candidates` para que
 * la UI lo muestre como ambiguo (no se auto-elige por seguridad).
 */

export interface EntidadCandidate {
  id: string;
  rutCanonico: string;
  nombreCanonico: string;
  aliases: string[];
  rubro: number | null;
}

export interface EntidadSuggestion {
  match: EntidadCandidate | null;
  candidates: EntidadCandidate[];
  reason: "exact" | "ambiguous" | "no-match" | "no-name";
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[._-]/g, " ").replace(/\s+/g, " ").trim();
}

export function suggestEntidadByName(
  holderName: string | null | undefined,
  entidades: EntidadCandidate[],
): EntidadSuggestion {
  if (!holderName || holderName.trim().length === 0) {
    return { match: null, candidates: [], reason: "no-name" };
  }
  const n = norm(holderName);

  const hits: EntidadCandidate[] = [];
  for (const e of entidades) {
    const variants = [e.nombreCanonico, ...e.aliases].map(norm).filter((v) => v.length > 0);
    if (variants.some((v) => n.includes(v) || v.includes(n))) {
      hits.push(e);
    }
  }

  if (hits.length === 0) {
    return { match: null, candidates: [], reason: "no-match" };
  }
  if (hits.length === 1) {
    return { match: hits[0], candidates: hits, reason: "exact" };
  }
  return { match: null, candidates: hits, reason: "ambiguous" };
}
