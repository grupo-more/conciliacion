/**
 * Parser robusto de mCjObs (Dynatech) y descripciones bancarias.
 * Extrae todas las pistas posibles para mejorar el matching.
 */

import { normalizeRut } from "@/lib/cartolas/normalize";

export interface GlosaParsed {
  bank: "BCI" | "SANTANDER" | "INTERNACIONAL" | null;
  unregisteredBank: string | null; // BICE, ITAU, CHILE, etc.
  holder: "ME SPA" | "MG SPA" | "BACO SPA" | "MORECAPITAL" | null;
  rut: string | null;
  /** Número de giro/app de la empresa (ej: "MORE GIROS 12906"). */
  giroNumber: string | null;
  /** Texto libre del cliente cuando aparece (palabras tipo nombre propio). */
  clientHint: string | null;
  /** Score de calidad de glosa: cuánta info útil aporta. 0-100. */
  quality: GlosaQuality;
}

export type GlosaQuality =
  | "EXCELLENT" // ≥3 piezas (banco + empresa + cliente/RUT/giro)
  | "GOOD"      // 2 piezas
  | "FAIR"      // 1 pieza
  | "POOR";     // ninguna pieza identificable

const REGISTERED_BANK_PATTERNS: Array<{
  bank: GlosaParsed["bank"];
  patterns: RegExp[];
}> = [
  { bank: "BCI", patterns: [/\bBCI\b/i] },
  {
    bank: "SANTANDER",
    patterns: [/\bSANTAN(?:D|N)?ER\b/i, /\bSANTNADER\b/i, /\bSANTADNER\b/i, /\bSANTNDER\b/i],
  },
  {
    bank: "INTERNACIONAL",
    patterns: [/\bINTERNACIONAL\b/i, /\bMORE\s*CAPITAL\b/i],
  },
];

const UNREGISTERED_BANKS: Array<{ name: string; patterns: RegExp[] }> = [
  { name: "BICE", patterns: [/\bBICE\b/i] },
  { name: "ITAU", patterns: [/\bITAU\b/i, /\bITAÚ\b/i] },
  { name: "CHILE", patterns: [/\bb(?:co|anco)\.?\s+(?:de\s+)?chile\b/i, /\bBCO\.\s*CHILE\b/i] },
  { name: "FALABELLA", patterns: [/\bFALABELLA\b/i] },
  { name: "ESTADO", patterns: [/\bESTADO\b/i] },
  { name: "SCOTIABANK", patterns: [/\bSCOTIA(?:BANK)?\b/i] },
  { name: "SECURITY", patterns: [/\bSECURITY\b/i] },
  { name: "RIPLEY", patterns: [/\bRIPLEY\b/i] },
  { name: "CONSORCIO", patterns: [/\bCONSORCIO\b/i] },
  { name: "BTG", patterns: [/\bBTG\b/i] },
  { name: "HSBC", patterns: [/\bHSBC\b/i] },
];

const HOLDER_PATTERNS: Array<{
  holder: GlosaParsed["holder"];
  patterns: RegExp[];
}> = [
  { holder: "ME SPA", patterns: [/\bME\s+SPA\b/i, /\bME\b(?!\s*[a-z])/i, /\bDEP\.?\s*ME\b/i, /\bDEP\.?\s*[A-Z]+\s+ME\b/i] },
  { holder: "MG SPA", patterns: [/\bMG\s+SPA\b/i, /\bMG\b(?!\s*[a-z])/i, /\bDEP\.?\s*MG\b/i] },
  { holder: "BACO SPA", patterns: [/\bBACO\b/i] },
  { holder: "MORECAPITAL", patterns: [/\bMORE\s*CAPITAL\b/i, /\bMORECAP\b/i] },
];

const GIRO_PATTERNS: RegExp[] = [
  /\bMORE\s+GIROS?\s*(?:NRO\.?)?\s*(\d{3,8})/i,
  /\bGIRO\s+APP\s*(\d{3,8})/i,
  /\bAPP\s+MORE\s+GIROS?\s*(?:NRO\.?)?\s*(\d{3,8})/i,
  /\bMORE\s+GIROS?\b.*?(\d{3,8})/i,
];

const RUT_PATTERN = /(\d{1,2}[.,]?\d{3}[.,]?\d{3}-?[\dKk])/;

/* -------------------------------------------------------------------------- */

export function parseGlosa(text: string): GlosaParsed {
  const t = text.trim();

  let bank: GlosaParsed["bank"] = null;
  for (const b of REGISTERED_BANK_PATTERNS) {
    if (b.patterns.some((p) => p.test(t))) {
      bank = b.bank;
      break;
    }
  }

  let unregisteredBank: string | null = null;
  for (const u of UNREGISTERED_BANKS) {
    if (u.patterns.some((p) => p.test(t))) {
      unregisteredBank = u.name;
      break;
    }
  }
  // Si "INTERNACIONAL" matcheó como registrado, no lo marques como unregistered
  // (aunque CHILE no debería matchearlo, defensivo)

  let holder: GlosaParsed["holder"] = null;
  for (const h of HOLDER_PATTERNS) {
    if (h.patterns.some((p) => p.test(t))) {
      holder = h.holder;
      break;
    }
  }

  let giroNumber: string | null = null;
  for (const p of GIRO_PATTERNS) {
    const m = t.match(p);
    if (m && m[1]) {
      giroNumber = m[1];
      break;
    }
  }

  const rutMatch = t.match(RUT_PATTERN);
  const rut = rutMatch ? normalizeRut(rutMatch[1]) : null;

  const clientHint = extractClientHint(t);

  const pieces = [bank, holder, rut, giroNumber, clientHint].filter(Boolean).length;
  let quality: GlosaQuality = "POOR";
  if (pieces >= 3) quality = "EXCELLENT";
  else if (pieces === 2) quality = "GOOD";
  else if (pieces === 1) quality = "FAIR";

  return {
    bank,
    unregisteredBank: bank ? null : unregisteredBank, // banco registrado tiene prioridad
    holder,
    rut,
    giroNumber,
    clientHint,
    quality,
  };
}

/**
 * Intenta extraer un hint del nombre del cliente quitando palabras técnicas
 * (DEP, BANCO, BCI, etc.). No es perfecto pero ayuda como pista secundaria.
 */
function extractClientHint(text: string): string | null {
  // Quitar prefijos comunes
  let s = text.toUpperCase();
  s = s.replace(/^DEP(?:OSITO)?\.?\s*/i, "");
  s = s.replace(/^GIRO\s+APP\s+\d+,?\s*/i, "");
  s = s.replace(/\bMORE\s+GIROS?\s*(?:NRO\.?)?\s*\d+\b/gi, "");
  s = s.replace(/\bAPP\s+MORE\s+GIROS?\b/gi, "");
  s = s.replace(/\bDEP(?:OSITO)?\b/gi, "");
  s = s.replace(/\bBANCO\b|\bBCO\.?\b/gi, "");
  s = s.replace(/\bCUENTA\s+BANCARIA\b/gi, "");
  s = s.replace(/\bPENDIENTE\b/gi, "");
  s = s.replace(/\bPOR\s+DEPOSITAR\b/gi, "");
  s = s.replace(/\bCC\b|\bCTA\.?\b/gi, "");
  s = s.replace(/\b(BCI|SANTANDER|SANTNADER|SANTADNER|INTERNACIONAL|BICE|ITAU|FALABELLA|CHILE|ESTADO|SECURITY|SCOTIABANK|RIPLEY|CONSORCIO|BTG|HSBC)\b/gi, "");
  s = s.replace(/\b(ME|MG|BACO|MORECAPITAL)\s+SPA\b/gi, "");
  s = s.replace(/\b(ME|MG|BACO|MORECAPITAL)\b/gi, "");
  // RUT
  s = s.replace(/\d{1,2}[.,]?\d{3}[.,]?\d{3}-?[\dKk]/g, "");
  // Puntuación
  s = s.replace(/[.,;:!?\-_]/g, " ");
  // Espacios redundantes
  s = s.replace(/\s+/g, " ").trim();

  if (s.length < 4) return null;
  // Si solo quedan palabras muy cortas o números, descartar
  const words = s.split(" ").filter((w) => w.length >= 2 && /[A-ZÁÉÍÓÚÑ]/.test(w));
  if (words.length === 0) return null;
  return words.slice(0, 5).join(" ");
}

/**
 * Devuelve los RUTs únicos presentes en una descripción (puede haber varios).
 */
export function extractRuts(text: string): string[] {
  const matches = text.match(new RegExp(RUT_PATTERN.source, "g"));
  if (!matches) return [];
  const ruts = matches
    .map((m) => normalizeRut(m))
    .filter((r): r is string => r !== null);
  return Array.from(new Set(ruts));
}
