import type { WorkBook } from "xlsx";
import type { BankParser, PdfBankParser } from "./types";
import { PARSERS, PDF_PARSERS } from "./parsers";

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

/**
 * Equivalente para PDF: detecta el parser que corresponde al texto extraido.
 */
export function detectPdfParser(text: string): PdfBankParser | null {
  for (const parser of PDF_PARSERS) {
    try {
      if (parser.matches(text)) return parser;
    } catch {
      // mismo criterio: ignoramos fallas de matches
    }
  }
  return null;
}

/**
 * Sniffea el magic byte de un buffer para decidir si es PDF. Los PDF empiezan
 * con la cadena "%PDF". No es 100% infalible (un buffer puede mentir) pero
 * combinado con la extension del archivo es suficiente.
 */
export function isPdfBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return (
    buf[0] === 0x25 /* % */ &&
    buf[1] === 0x50 /* P */ &&
    buf[2] === 0x44 /* D */ &&
    buf[3] === 0x46 /* F */
  );
}
