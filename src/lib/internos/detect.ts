/**
 * Deteccion de egresos a entidades internas en cartolas bancarias.
 *
 * El problema:
 *   - El banco a veces trae counterpartyRut, a veces solo counterpartyName,
 *     a veces ninguno. Cuando viene solo nombre, las variantes son N (ej.
 *     "More Capital Spa", "MORE CAPITAL S", "Internet a 76.815.928-9", etc.).
 *   - Tambien hay casos donde el RUT viaja en la glosa (description) prefijado
 *     como 10 digitos: "0768159289 Transf a MORE CAPITAL S".
 *
 * La cascada de deteccion va de mas a menos confiable:
 *   1. counterpartyRut matchea una EntidadInterna -> rut.
 *   2. counterpartyName contiene un RUT parseable -> rut_in_name.
 *   3. description arranca con 10 digitos parseables como RUT -> rut_in_desc.
 *   4. counterpartyName matchea un alias registrado (palabra entera) -> alias.
 *   5. Nada -> no es interno.
 *
 * El matching por alias usa bordes de palabra (\b) en regex, porque hubo casos
 * de falso positivo con substrings cortos: alias "ME" pegaba contra
 * "Comercializado", "Sociedad Comer", "BADER . YAMEN", etc. — todas filas que
 * NO eran ME SPA. Con \bme\b solo matchea cuando "me" es palabra entera.
 */

export type MatchVia = "rut" | "rut_in_name" | "rut_in_desc" | "alias";

export interface EntidadInternaLite {
  id: string;
  rutCanonico: string; // ya normalizado (digitos + K, sin puntos ni guion)
  nombreCanonico: string;
  aliases: string[];
  rubro: number | null;
}

export interface InternoMatch {
  entidad: EntidadInternaLite;
  via: MatchVia;
  /** Texto exacto que disparo el match — util para mostrar en la UI/auditar. */
  evidence: string;
}

/**
 * Normaliza un RUT chileno: deja solo digitos + K mayuscula, sin puntos ni
 * guion. "77.333.097-2" -> "773330972". null/undefined/vacio -> "".
 */
export function normalizeRut(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/[^0-9kK]/g, "").toUpperCase();
}

/**
 * Intenta extraer un RUT de un texto libre. Estrategia:
 *   - Si arranca con 8-10 digitos consecutivos (con o sin DV), tomar ese
 *     prefijo. Ejemplo: "0768159289 Transf a MORE CAPITAL S" -> "0768159289"
 *     (que al normalizar y matchear contra rutCanonico "768159289" tiene que
 *     ser tolerante con el cero a la izquierda — ver matchRut).
 *   - Si en el medio aparece un RUT con formato XX.XXX.XXX-X, lo toma.
 *   - Si nada calza, retorna "".
 */
export function extractRut(text: string | null | undefined): string {
  if (!text) return "";
  const t = String(text);

  // Patron formal: 11.111.111-K o 11111111-K
  const formal = t.match(/(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK])/);
  if (formal) return normalizeRut(formal[1]);

  // Prefijo de 8-10 digitos al inicio (los bancos prefijan el RUT en la glosa
  // como "07733330972 Transf a ..."). Tomamos los primeros 8-11 digitos.
  const prefix = t.match(/^(\d{8,11})\b/);
  if (prefix) return normalizeRut(prefix[1]);

  // Cualquier secuencia de 8-9 digitos en medio del texto: candidato.
  const any = t.match(/\b(\d{8,9}[\dkK])\b/);
  if (any) return normalizeRut(any[1]);

  return "";
}

/**
 * Compara dos RUTs normalizados con tolerancia a cero a la izquierda. Los
 * bancos a veces prefijan "0" al RUT en glosa (ej. "0768159289" vs real
 * "768159289"). Tambien a veces falta el DV (digito verificador).
 */
export function matchRut(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ax = a.replace(/^0+/, "");
  const bx = b.replace(/^0+/, "");
  if (ax === bx) return true;
  // Tolerar falta de DV en uno de los dos (ej. "76815928" vs "768159289").
  if (ax.length >= 7 && bx.startsWith(ax)) return true;
  if (bx.length >= 7 && ax.startsWith(bx)) return true;
  return false;
}

/**
 * Escapa metacaracteres regex en un string. Usado para construir alias-regex
 * sin que un alias con "." o "(" rompa el patron.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Construye una regex que matchea el alias como palabra (con bordes \b).
 * Case-insensitive. Tolerante a espacios multiples dentro del alias.
 */
function aliasRegex(alias: string): RegExp {
  const escaped = escapeRegex(alias.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i");
}

/**
 * Aplica la cascada de deteccion contra un BankMovement.
 * Retorna el primer match en orden de confianza, o null si no es interno.
 */
export function detectInterno(
  m: {
    counterpartyRut?: string | null;
    counterpartyName?: string | null;
    description?: string | null;
  },
  entidades: EntidadInternaLite[],
): InternoMatch | null {
  // 1) Match por RUT directo.
  const rutDirect = normalizeRut(m.counterpartyRut);
  if (rutDirect) {
    for (const e of entidades) {
      if (matchRut(rutDirect, e.rutCanonico)) {
        return { entidad: e, via: "rut", evidence: m.counterpartyRut! };
      }
    }
  }

  // 2) RUT incrustado en counterpartyName ("Internet a 76.815.928-9").
  const rutInName = extractRut(m.counterpartyName);
  if (rutInName) {
    for (const e of entidades) {
      if (matchRut(rutInName, e.rutCanonico)) {
        return {
          entidad: e,
          via: "rut_in_name",
          evidence: m.counterpartyName!,
        };
      }
    }
  }

  // 3) RUT prefijado en description ("0768159289 Transf a MORE CAPITAL S").
  const rutInDesc = extractRut(m.description);
  if (rutInDesc) {
    for (const e of entidades) {
      if (matchRut(rutInDesc, e.rutCanonico)) {
        return {
          entidad: e,
          via: "rut_in_desc",
          evidence: m.description!,
        };
      }
    }
  }

  // 4) Alias por palabra entera en counterpartyName.
  const name = (m.counterpartyName ?? "").trim();
  if (name) {
    for (const e of entidades) {
      for (const a of e.aliases) {
        if (!a || a.trim().length === 0) continue;
        if (aliasRegex(a).test(name)) {
          return { entidad: e, via: "alias", evidence: a };
        }
      }
    }
  }

  return null;
}

/** Cargar todas las entidades activas — set chico, va a memoria. */
export async function loadEntidadesInternas(prisma: {
  entidadInterna: {
    findMany: (args: {
      where: { active: boolean };
      select: {
        id: true;
        rutCanonico: true;
        nombreCanonico: true;
        aliases: true;
        rubro: true;
      };
    }) => Promise<EntidadInternaLite[]>;
  };
}): Promise<EntidadInternaLite[]> {
  return prisma.entidadInterna.findMany({
    where: { active: true },
    select: {
      id: true,
      rutCanonico: true,
      nombreCanonico: true,
      aliases: true,
      rubro: true,
    },
  });
}
