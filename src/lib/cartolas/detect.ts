import type { WorkBook } from "xlsx";
import type { BankParser } from "./types";
import { PARSERS } from "./parsers";

/**
 * Detecta qué parser corresponde a un workbook leído de un Excel de cartola.
 * Devuelve null si ningún parser reconoce el formato.
 */
export function detectParser(wb: WorkBook): BankParser | null {
  for (const parser of PARSERS) {
    try {
      if (parser.matches(wb)) return parser;
    } catch {
      // Si un matches() falla (archivo malformado), seguimos con el siguiente.
    }
  }
  return null;
}
