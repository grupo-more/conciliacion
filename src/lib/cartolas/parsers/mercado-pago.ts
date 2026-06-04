import type {
  NormalizedMovement,
  ParsedStatement,
  PdfBankParser,
} from "../types";
import { parseAmount } from "../normalize";

/**
 * Mercado Pago — cartola PDF de "Emisora no Bancaria de Tarjeta de Pago".
 *
 * Layout del texto extraido (pdf-parse):
 *
 *   Header con metadata:
 *     "Mercado Pago Emisora S.A."
 *     "77.214.066-5 Avenida Apoquindo 4800, torre 2,
 *      piso 21, Las Condes, Santiago, Chile. MORE EXCHANGE SPA"
 *     "DESDE HASTA FECHA DE GENERACION ID DE USUARIO
 *      01-05-2026 00:00:00 31-05-2026 23:59:59 02-06-2026 12:45:17 2535150984"
 *
 *   Encabezado de tabla:
 *     "FECHA DE ACREDITACION TIPO DE MOVIMIENTO TIPO DE TRANSACCION ID DE TRANSACCION MONEDA MONTO DE TRANSACCION OTROS CONCEPTOS NOMBRE DEL COMERCIO"
 *
 *   Cada movimiento es una linea sola:
 *     "04-05-2026 16:25:49 Abono Transferencia recibida 157700958304 CLP 2.300.000,00 0,00"
 *     "04-05-2026 16:27:08 Cargo Transferencia enviada  156933377733 CLP -2.300.200,00 0,00"
 *
 * Notas:
 *  - El PDF no trae RUT del titular — queda undefined y se carga manual.
 *  - "ID DE USUARIO" (ej. 2535150984) es el accountNumber.
 *  - "ID DE TRANSACCION" es unico → perfecto para externalId/dedup.
 *  - Glosa pobre: "Transferencia recibida" / "enviada". Sin contraparte.
 *    Esto limita el detector de internos: solo funcionara via matching por
 *    monto+fecha desde el otro lado (la cuenta origen del traspaso).
 */
export const mercadoPagoParser: PdfBankParser = {
  code: "MERCADO_PAGO",
  bankCode: "MERCADOPAGO",
  bankName: "Mercado Pago",
  format: "pdf",

  matches(text) {
    // Firma robusta: nombre emisor + columnas tipicas.
    return (
      /Mercado\s*Pago\s*Emisora/i.test(text) &&
      /ID\s+DE\s+TRANSACCI/i.test(text)
    );
  },

  parse(text): ParsedStatement {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // --- Header: holder + accountNumber + periodo ---

    let holderName: string | undefined;
    let accountNumber: string | undefined;
    let periodFrom: Date | null = null;
    let periodTo: Date | null = null;

    // Holder: "...Santiago, Chile. <HOLDER>"
    for (const line of lines) {
      const m = line.match(/Santiago,\s*Chile\.\s+(.+?)$/i);
      if (m) {
        holderName = m[1].trim();
        break;
      }
    }

    // accountNumber + periodo: la linea de valores viene justo despues del
    // header "DESDE HASTA FECHA DE GENERACI(O|O)N ID DE USUARIO".
    for (let i = 0; i < lines.length; i++) {
      if (/ID\s+DE\s+USUARIO/i.test(lines[i])) {
        const value = lines[i + 1];
        if (!value) break;
        // "DD-MM-YYYY HH:MM:SS DD-MM-YYYY HH:MM:SS DD-MM-YYYY HH:MM:SS <ID>"
        const tokens = value.split(/\s+/);
        // El ultimo token es el ID; los anteriores son 3 pares de
        // fecha-hora. Tomamos el primero (DESDE) y el segundo (HASTA).
        accountNumber = tokens[tokens.length - 1];
        if (tokens.length >= 4) {
          periodFrom = parseMpDateOnly(tokens[0]);
          periodTo = parseMpDateOnly(tokens[2]);
        }
        break;
      }
    }

    // --- Movimientos ---

    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    // Regex de una linea de movimiento. Tolera espacios multiples.
    // Captura:
    //   1: fecha    DD-MM-YYYY
    //   2: hora     HH:MM:SS
    //   3: tipoMov  Abono | Cargo
    //   4: tipoTrx  "Transferencia recibida" / "Transferencia enviada" / otros
    //   5: idTrx    digitos
    //   6: monto    con signo, formato chileno
    //   7: otros    monto secundario (comision/retencion)
    const re =
      /^(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(Abono|Cargo)\s+(.+?)\s+(\d{6,})\s+CLP\s+(-?[\d.,]+)\s+(-?[\d.,]+)\s*$/i;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const m = line.match(re);
      if (!m) continue;

      try {
        const [, dateStr, timeStr, tipoMov, tipoTrx, idTrx, montoStr] = m;
        const postDate = parseMpDateOnly(dateStr);
        if (!postDate) {
          errors.push({ rowIndex: idx + 1, reason: "Fecha invalida", raw: line });
          continue;
        }

        const parsedAmount = parseAmount(montoStr);
        if (parsedAmount === null || parsedAmount === 0) {
          errors.push({ rowIndex: idx + 1, reason: "Monto invalido", raw: line });
          continue;
        }

        // Forzar signo segun tipo de movimiento; el PDF a veces trae el
        // signo en el monto, a veces no — confiamos en la palabra del tipo.
        const direction: "IN" | "OUT" =
          tipoMov.toLowerCase() === "abono" ? "IN" : "OUT";
        const finalAmount =
          direction === "IN" ? Math.abs(parsedAmount) : -Math.abs(parsedAmount);

        // Combinar hora con fecha para transactionDate (precision util).
        const transactionDate = new Date(postDate);
        const th = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})$/);
        if (th) transactionDate.setHours(+th[1], +th[2], +th[3], 0);

        if (!periodFrom || postDate < periodFrom) periodFrom = postDate;
        if (!periodTo || postDate > periodTo) periodTo = postDate;

        movements.push({
          externalId: idTrx,
          postDate,
          transactionDate,
          amount: finalAmount,
          currency: "CLP",
          direction,
          description: tipoTrx.trim(),
          balanceAfter: null,
          counterpartyName: null,
          counterpartyRut: null,
          counterpartyAccount: null,
          counterpartyBank: null,
          branchLabel: null,
          txType: tipoMov.toUpperCase(),
          rawRow: {
            line,
            tipoMov,
            tipoTrx: tipoTrx.trim(),
            idTrx,
            montoStr,
            timeStr,
          },
        });
      } catch (e) {
        errors.push({
          rowIndex: idx + 1,
          reason: e instanceof Error ? e.message : "Error",
          raw: line,
        });
      }
    }

    return {
      parserCode: "MERCADO_PAGO",
      account: {
        bankCode: "MERCADOPAGO",
        accountNumber: accountNumber ?? "",
        displayNumber: accountNumber,
        holderName,
        holderRut: undefined,
        currency: "CLP",
      },
      periodFrom,
      periodTo,
      movements,
      errors,
      metadata: { lineCount: lines.length },
    };
  },
};

function parseMpDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1]);
}
