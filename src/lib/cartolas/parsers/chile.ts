import * as XLSX from "xlsx";
import type { BankParser, NormalizedMovement, ParsedStatement } from "../types";
import {
  asStr,
  isEmptyRow,
  normalizeAccountNumber,
  normalizeRut,
  parseAmount,
  parseDate,
} from "../normalize";

/**
 * Banco de Chile - "Movimientos de cuenta corriente" (.xls genérico).
 *
 * Layout:
 *   Hoja: "Sheet1" (genérica)
 *   Fila 1: "NOMBRE EMPRESA (RUT) cta:NNNNNNNNNNNN"
 *           ej. "ME SPA                                      (77333096-4) cta:000051541406"
 *   Fila 2: HEADERS:
 *           Fecha | Detalle Movimiento | Cheque o Cargo | Deposito o Abono |
 *           Saldo | Docto. Nro. | Trn | Caja | Sucursal
 *   Fila 3+: datos
 *
 * Notas:
 *  - Montos vienen como strings de 22 dígitos con ceros a la izquierda
 *    (ej. "0000000000000000300000" = 300.000).
 *  - Saldo trae prefijo de signo ("+...") - parseAmount ya lo tolera.
 *  - Cargo y Abono en columnas separadas (como Banco Internacional).
 *  - Fechas mixtas (4 dígitos y 2 dígitos de año) - parseDate ya lo soporta.
 *  - Sin periodo en el header: se deriva del rango de fechas.
 *  - "Docto. Nro." siempre "0...0" -> no es ID confiable.
 *  - Contraparte en glosa: "Traspaso A: NOMBRE" / "Traspaso De: NOMBRE".
 */
export const chileMovimientosParser: BankParser = {
  code: "CHILE_MOVIMIENTOS",
  bankCode: "CHILE",
  bankName: "Banco de Chile",

  matches(wb) {
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return false;
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return false;

    // Verificar firma de fila 1: contiene "cta:NNNN..."
    const a1 = asStr(sheet["A1"]?.v);
    if (!/cta\s*:\s*\d+/i.test(a1)) return false;

    // Verificar headers de fila 2
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
      range: 1, // empieza desde fila 2 (índice 1)
    });
    const headers = (aoa[0] || []).map((h) => asStr(h).toLowerCase());
    if (headers.length < 5) return false;
    return (
      headers[0] === "fecha" &&
      headers[1].includes("detalle") &&
      headers[2].includes("cargo") &&
      headers[3].includes("abono") &&
      headers[4] === "saldo"
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

    // Parsear fila 1: "NOMBRE (RUT) cta:NUMERO"
    const a1 = asStr(aoa[0]?.[0]);
    const account = parseChileAccountHeader(a1);

    // Headers en fila 2 (índice 1), datos desde fila 3 (índice 2)
    const headers = (aoa[1] || []).map((h) => asStr(h));
    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    let periodFrom: Date | null = null;
    let periodTo: Date | null = null;

    for (let i = 2; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      try {
        const postDate = parseDate(row[0]);
        const description = asStr(row[1]);
        const cargo = parseAmount(row[2]) ?? 0;
        const abono = parseAmount(row[3]) ?? 0;
        const saldo = parseAmount(row[4]);
        const nDoc = asStr(row[5]);
        const sucursal = asStr(row[8]) || null;

        if (!postDate) {
          errors.push({ rowIndex: i + 1, reason: "Sin fecha", raw: row });
          continue;
        }

        let amount: number;
        if (abono > 0 && cargo === 0) amount = abono;
        else if (cargo > 0 && abono === 0) amount = -cargo;
        else if (cargo === 0 && abono === 0) {
          errors.push({ rowIndex: i + 1, reason: "Movimiento en cero", raw: row });
          continue;
        } else {
          // Caso raro: ambos > 0 → priorizar el mayor.
          amount = abono > cargo ? abono : -cargo;
        }

        const externalId =
          nDoc && /^0+$/.test(nDoc) === false && nDoc.replace(/\D/g, "") !== ""
            ? nDoc.replace(/^0+(?=\d)/, "")
            : null;

        if (!periodFrom || postDate < periodFrom) periodFrom = postDate;
        if (!periodTo || postDate > periodTo) periodTo = postDate;

        const rawRow: Record<string, unknown> = {};
        headers.forEach((h, idx) => {
          rawRow[h || `col_${idx}`] = row[idx] ?? null;
        });

        movements.push({
          externalId,
          postDate,
          transactionDate: null,
          amount,
          currency: "CLP",
          direction: amount >= 0 ? "IN" : "OUT",
          description,
          balanceAfter: saldo,
          counterpartyName: extractCounterpartyName(description),
          counterpartyRut: null,
          counterpartyAccount: null,
          counterpartyBank: null,
          branchLabel: sucursal,
          txType: amount >= 0 ? "ABONO" : "CARGO",
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
      parserCode: "CHILE_MOVIMIENTOS",
      account,
      periodFrom,
      periodTo,
      movements,
      errors,
      metadata: { sheetName, headers },
    };
  },
};

/**
 * Parsea la fila de header "NOMBRE                  (RUT) cta:NUMERO".
 */
function parseChileAccountHeader(a1: string): ParsedStatement["account"] {
  const ctaMatch = a1.match(/cta\s*:\s*(\d+)/i);
  const displayNumber = ctaMatch ? ctaMatch[1] : undefined;
  const accountNumber = displayNumber ? normalizeAccountNumber(displayNumber) : "";

  const rutMatch = a1.match(/\((\d{1,2}\.?\d{3}\.?\d{3}-?[\dKk])\)/);
  const holderRut = rutMatch ? normalizeRut(rutMatch[1]) ?? undefined : undefined;

  let holderName: string | undefined;
  if (rutMatch) {
    holderName = a1.slice(0, rutMatch.index).trim() || undefined;
  }

  return {
    bankCode: "CHILE",
    accountNumber,
    displayNumber,
    holderName,
    holderRut,
    currency: "CLP",
  };
}

/**
 * Extrae nombre de contraparte de glosas tipo:
 *   "Traspaso A: Sonia Munoz Guinez"
 *   "Traspaso De: Me Spa"
 * Devuelve null para glosas operacionales (Comision, Cargo Seguro, Provision, etc).
 */
function extractCounterpartyName(glosa: string): string | null {
  if (!glosa) return null;
  const m = glosa.match(/^Traspaso\s+(?:A|De|De:|A:)\s*:?\s*(.+?)$/i);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name.length < 3) return null;
  return name;
}
