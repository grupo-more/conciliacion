/**
 * Parser de glosa de Tesorería.
 *
 * Formato estándar acordado con las sucursales:
 *   DEP <RUT_CLIENTE> <BANCO> <EMPRESA_DESTINO>
 *   ej. "DEP 16656626-6 BCI ME"
 *
 * Para depósitos que se cargan en Tesorería como múltiples movimientos
 * (porque la sucursal separó por factura, por boleta, o porque cubren más
 * de un concepto) pero corresponden a UNA sola transferencia bancaria, la
 * sucursal antepone un marcador secuencial (N):
 *   DEP (1) 16.201.411-0 Santander ME
 *   DEP (2) 16.201.411-0 Santander ME
 *   DEP (3) 16.201.411-0 Santander ME
 *
 * Este parser detecta ambos formatos. Cuando `isMultiPart` es true, el
 * auto-matcher debe abstenerse de scorear ese movimiento contra cartolas
 * (porque su monto es solo una porción del depósito real) y forzar revisión
 * manual: ver match.ts. La UI del módulo Comparar usa los campos
 * `rut`/`banco`/`empresa` para agrupar visualmente las partes de un mismo
 * depósito y sugerir al operador seleccionarlas juntas.
 *
 * El parser es defensivo: si la glosa no respeta el formato (sucursales
 * que olvidan el RUT, escriben en orden distinto, etc.) devuelve los
 * campos como null y `isMultiPart: false`. Nunca tira excepción.
 */

export interface ParsedGlosa {
  /** True si la glosa lleva el marcador `(N)` indicando que es parte de
   *  un depósito agrupado. El auto-matcher debe excluir estos casos. */
  isMultiPart: boolean;
  /** Número secuencial del marcador, si está presente. */
  partNumber: number | null;
  /** RUT del cliente (sin puntos, con guion). null si no se pudo extraer. */
  rut: string | null;
  /** Banco/empresa destino tal como aparece en la glosa (ej. "BCI ME",
   *  "Santander ME"). Útil para agrupar partes del mismo depósito. */
  banco: string | null;
  /** Tokens restantes después de banco, si los hay (ej. nombre de empresa
   *  cuando se usa el fallback sin RUT). null si no aplica. */
  empresa: string | null;
  /** Glosa original limpia (sin el prefijo DEP ni el marcador). Útil para
   *  display y debugging. */
  rest: string;
}

const DEP_PREFIX_RE = /^\s*DEP(?:OSITO)?S?\s+/i;
// Marcador multipart: EXIGE paréntesis para distinguir del folio. La sucursal
// pone "(1)", "(2)", "(3)" cuando un depósito se cargó en N tesorerías. Sin
// los paréntesis, "DEP 1166751 SANTANDER ME" (donde 1166751 es el folio) se
// matcheaba como multipart por error.
const MULTIPART_RE = /^\((\d{1,3})\)\s+/;

/** Quita puntos del RUT y normaliza a "12345678-K" (mayúsculas, con guion). */
function normalizeRutLoose(raw: string): string | null {
  const cleaned = raw.replace(/\./g, "").replace(/\s/g, "").toUpperCase();
  // Match flexible: 7-9 dígitos + guion opcional + dígito verificador o K
  const m = cleaned.match(/^(\d{7,9})-?([0-9K])$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

const KNOWN_BANK_TOKENS = new Set([
  "BCI",
  "SANTANDER",
  "ITAU",
  "INTERNACIONAL",
  "ESTADO",
  "CHILE",
  "SCOTIA",
  "SCOTIABANK",
  "SECURITY",
  "BICE",
  "FALABELLA",
  "RIPLEY",
  "CONSORCIO",
  "CORPBANCA",
]);
const KNOWN_EMPRESA_TOKENS = new Set([
  "ME",
  "BAGO",
  "MG",
  "MOREGIROS",
  "SPA",
  "LTDA",
]);

export function parseGlosa(glosaRaw: string | null | undefined): ParsedGlosa {
  const empty: ParsedGlosa = {
    isMultiPart: false,
    partNumber: null,
    rut: null,
    banco: null,
    empresa: null,
    rest: "",
  };
  if (!glosaRaw) return empty;

  // 1) Saco el prefijo DEP/DEPOSITO si está
  let body = glosaRaw.trim();
  const prefixMatch = body.match(DEP_PREFIX_RE);
  if (prefixMatch) body = body.slice(prefixMatch[0].length).trim();

  // 2) Detecto marcador multipart "(N)" o "N)" al inicio
  let isMultiPart = false;
  let partNumber: number | null = null;
  const mpMatch = body.match(MULTIPART_RE);
  if (mpMatch) {
    isMultiPart = true;
    partNumber = Number(mpMatch[1]);
    body = body.slice(mpMatch[0].length).trim();
  }

  if (!body) {
    return { ...empty, isMultiPart, partNumber, rest: "" };
  }

  // 3) Extraigo RUT (primer token que parsee como RUT)
  const tokens = body.split(/\s+/);
  let rut: string | null = null;
  let rutIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const r = normalizeRutLoose(tokens[i]);
    if (r) {
      rut = r;
      rutIdx = i;
      break;
    }
  }

  // 4) Tokens posteriores al RUT → banco + empresa
  let banco: string | null = null;
  let empresa: string | null = null;
  const after = rutIdx >= 0 ? tokens.slice(rutIdx + 1) : tokens;

  if (after.length > 0) {
    // Heurística simple: si el primer token está en KNOWN_BANK_TOKENS, ese
    // y los siguientes EMPRESA_TOKENS componen el banco. El resto, empresa.
    const upperAfter = after.map((t) => t.toUpperCase());
    const firstIsBank = KNOWN_BANK_TOKENS.has(upperAfter[0]);
    if (firstIsBank) {
      const bancoTokens: string[] = [after[0]];
      let i = 1;
      while (i < after.length && KNOWN_EMPRESA_TOKENS.has(upperAfter[i])) {
        bancoTokens.push(after[i]);
        i++;
      }
      banco = bancoTokens.join(" ");
      if (i < after.length) empresa = after.slice(i).join(" ");
    } else {
      // Sin token de banco conocido al frente: lo dejamos todo como banco
      // para no perder info. La UI usa esto solo como pista, no como verdad.
      banco = after.join(" ");
    }
  }

  return {
    isMultiPart,
    partNumber,
    rut,
    banco,
    empresa,
    rest: body,
  };
}

/**
 * Clave de agrupamiento para identificar partes del mismo depósito.
 *
 * Dos TesoreriaMovements pertenecen al mismo grupo (potencial split inverso)
 * si comparten esta clave Y están dentro de una ventana de fechas corta.
 * Usa `clienteRut` de la TM como source of truth (más confiable que el RUT
 * parseado de la glosa, que puede tener typos).
 */
export function groupKey(
  clienteRut: string | null | undefined,
  banco: string | null | undefined
): string | null {
  if (!clienteRut || !banco) return null;
  const rut = clienteRut.replace(/\./g, "").trim().toUpperCase();
  if (!rut) return null;
  return `${rut}|${banco.trim().toLowerCase()}`;
}
