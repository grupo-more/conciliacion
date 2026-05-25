import * as XLSX from "xlsx";
import type { BankParser, NormalizedMovement, ParsedStatement } from "../types";
import {
  asStr,
  combineDateTime,
  isEmptyRow,
  normalizeAccountNumber,
  normalizeRut,
  parseAmount,
  parseDate,
} from "../normalize";

/**
 * BCI - Cartola "Detallado" (Movimientos detallados de cuenta).
 *
 * Layout:
 *   Hoja: "Hoja 1"
 *   Fila 1: headers
 *   Fila 2+: datos
 *
 * Columnas (26):
 *   0: Fecha de transacción      1: Hora transacción         2: Fecha contable
 *   3: Código de transacción     4: Código Transferencia     5: Tipo de transacción
 *   6: Numero serie              7: Glosa detalle             8: Ingreso (+)
 *   9: Egreso (-)               10: Saldo contable          11: Nombre
 *  12: RUT                      13: N° de Cuenta             14: Tipo de Cuenta
 *  15: Banco                    16: Correo electrónico       17: Comentario transferencia
 *  18-25: campos opcionales (Servicio, N° Cliente, Empresa, etc.)
 *
 * El archivo no trae N° de cuenta propia ni datos de empresa explícitos en el contenido;
 * hay que inferirlos del nombre del archivo o pedirlos al usuario.
 */
export const bciDetalladoParser: BankParser = {
  code: "BCI_DETALLADO",
  bankCode: "BCI",
  bankName: "BCI",

  matches(wb) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return false;
    const headers = headerRow(sheet, 1);
    if (!headers) return false;
    const joined = headers.join("|").toLowerCase();
    return (
      joined.includes("código transferencia") &&
      joined.includes("glosa detalle") &&
      joined.includes("ingreso")
    );
  },

  parse(wb): ParsedStatement {
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    const headers = (aoa[0] || []).map((h) => asStr(h));
    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    let periodFrom: Date | null = null;
    let periodTo: Date | null = null;

    // Inferir cuenta del primer movimiento (el N° de cuenta propia no está,
    // pero podemos guardar el holder a partir del archivo). Por ahora dejamos
    // accountNumber vacío — quien suba el archivo seleccionará la cuenta destino.
    const accountNumber = "";

    for (let i = 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      try {
        const txDate = parseDate(row[0]);
        const time = row[1];
        const postDate = parseDate(row[2]) ?? txDate;
        const externalCodigoTrans = asStr(row[4]);
        const txType = asStr(row[5]) || null;
        const description = asStr(row[7]);
        const ingreso = parseAmount(row[8]);
        const egreso = parseAmount(row[9]);
        const saldo = parseAmount(row[10]);
        const counterpartyName = asStr(row[11]) || null;
        const counterpartyRut = normalizeRut(row[12]);
        const counterpartyAccount = asStr(row[13]) || null;
        const counterpartyBank = asStr(row[15]) || null;

        if (!postDate) {
          errors.push({ rowIndex: i + 1, reason: "Sin fecha contable", raw: row });
          continue;
        }

        let amount: number;
        if (ingreso !== null && ingreso !== 0) {
          amount = ingreso;
        } else if (egreso !== null && egreso !== 0) {
          amount = -Math.abs(egreso);
        } else {
          errors.push({ rowIndex: i + 1, reason: "Sin monto", raw: row });
          continue;
        }

        const transactionDate = combineDateTime(txDate, time);

        if (!periodFrom || postDate < periodFrom) periodFrom = postDate;
        if (!periodTo || postDate > periodTo) periodTo = postDate;

        const rawRow: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          rawRow[h || `col_${idx}`] = row[idx] ?? null;
        });

        movements.push({
          externalId: externalCodigoTrans || null,
          postDate,
          transactionDate,
          amount,
          currency: "CLP",
          direction: amount >= 0 ? "IN" : "OUT",
          description,
          balanceAfter: saldo,
          counterpartyName,
          counterpartyRut,
          counterpartyAccount: counterpartyAccount
            ? normalizeAccountNumber(counterpartyAccount)
            : null,
          counterpartyBank,
          branchLabel: null,
          txType,
          rawRow,
        });
      } catch (e) {
        errors.push({
          rowIndex: i + 1,
          reason: e instanceof Error ? e.message : "Error desconocido",
          raw: row,
        });
      }
    }

    return {
      parserCode: "BCI_DETALLADO",
      account: {
        bankCode: "BCI",
        accountNumber,
      },
      periodFrom,
      periodTo,
      movements,
      errors,
      metadata: { sheetName, headers },
    };
  },
};

function headerRow(sheet: XLSX.WorkSheet, row1: number): string[] | null {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
    range: row1 - 1,
  });
  const first = aoa[0];
  if (!first || first.length === 0) return null;
  return first.map((h) => asStr(h));
}
