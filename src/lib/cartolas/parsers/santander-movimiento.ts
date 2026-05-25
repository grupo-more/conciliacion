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
 * Santander - "CartolaMovimiento" (consulta de movimientos del día/rango corto).
 *
 * Layout:
 *   Hoja: "Movimientos CtaCte"
 *   Fila 1: "Consulta de movimientos de Cuentas Corrientes..."
 *   Fila 3: "Sr. (a):" | nombre | | | "Fecha:" | fecha
 *   Fila 4: "Empresa:" | nombre empresa | | | "Hora:" | hora
 *   Fila 5: "RUT empresa:" | rut
 *   Fila 7: "Cuenta Corriente N°: 0-000-XXXXXXX-X" | | "Moneda: PESOS DE CHILE" | | "Sucursal: ..."
 *   Fila 11: | | | | "Fecha desde: dd/mm/yyyy" | "Fecha hasta: dd/mm/yyyy"
 *   Fila 12: HEADERS: MONTO | DESCRIPCIÓN | FECHA | SALDO | N° DOCUMENTO | SUCURSAL | CARGO/ABONO
 *   Fila 13+: datos
 *
 * Notas:
 *  - N° DOCUMENTO suele venir "000000000" → no es ID confiable.
 *  - El monto ya viene con signo (negativo = cargo).
 *  - CARGO/ABONO: "A" = abono, "C" = cargo.
 */
export const santanderMovimientoParser: BankParser = {
  code: "SANTANDER_MOVIMIENTO",
  bankCode: "SANTANDER",
  bankName: "Santander",

  matches(wb) {
    if (!wb.SheetNames.includes("Movimientos CtaCte")) return false;
    const sheet = wb.Sheets["Movimientos CtaCte"];
    const a1 = asStr(sheet["A1"]?.v);
    if (!a1.toLowerCase().includes("consulta de movimientos")) return false;
    // Distinguir de la histórica: la histórica está en otra hoja (Cartola Historica CtaCte).
    return true;
  },

  parse(wb): ParsedStatement {
    const sheetName = "Movimientos CtaCte";
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    const account = parseSantanderAccountInfo(aoa);
    const { periodFrom, periodTo } = parseSantanderPeriod(aoa, 10); // fila 11

    // Headers en fila 12 (índice 11), datos desde fila 13 (índice 12)
    const headers = (aoa[11] || []).map((h) => asStr(h));
    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    for (let i = 12; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      try {
        const monto = parseAmount(row[0]);
        const description = asStr(row[1]);
        const postDate = parseDate(row[2]);
        const saldo = parseAmount(row[3]);
        const nDoc = asStr(row[4]);
        const sucursal = asStr(row[5]) || null;
        const cargoAbono = asStr(row[6]).toUpperCase();

        if (!postDate) {
          errors.push({ rowIndex: i + 1, reason: "Sin fecha", raw: row });
          continue;
        }
        if (monto === null) {
          errors.push({ rowIndex: i + 1, reason: "Sin monto", raw: row });
          continue;
        }

        // Asegurar signo según indicador A/C: si por alguna razón el monto viene
        // sin signo, lo aplicamos según cargo/abono.
        let amount = monto;
        if (cargoAbono === "C" && amount > 0) amount = -amount;
        if (cargoAbono === "A" && amount < 0) amount = Math.abs(amount);

        // N° DOC válido si no es 0/000000...
        const externalId =
          nDoc && /^0+$/.test(nDoc) === false && nDoc.replace(/\D/g, "") !== ""
            ? nDoc.replace(/^0+(?=\d)/, "")
            : null;

        // Extraer RUT de la glosa para "Transf.Internet a XX.XXX.XXX-X"
        const counterpartyRut = extractRutFromGlosa(description);

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
          counterpartyName: extractNameFromGlosa(description),
          counterpartyRut,
          counterpartyAccount: null,
          counterpartyBank: null,
          branchLabel: sucursal,
          txType: cargoAbono === "A" ? "ABONO" : cargoAbono === "C" ? "CARGO" : null,
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
      parserCode: "SANTANDER_MOVIMIENTO",
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
 * Extrae info de cuenta de la cabecera de Santander (común a Movimiento e Histórica).
 */
export function parseSantanderAccountInfo(aoa: unknown[][]): ParsedStatement["account"] {
  const row3 = aoa[2] || []; // "Sr. (a):" + nombre
  const row4 = aoa[3] || []; // "Empresa:" + nombre
  const row5 = aoa[4] || []; // "RUT empresa:" + rut
  const row7 = aoa[6] || []; // "Cuenta Corriente N°: 0-000-XXXXXXX-X"

  const empresa = asStr(row4[1]) || undefined;
  const rutEmpresa = normalizeRut(row5[1]) ?? undefined;

  const cuentaCell = asStr(row7[0]); // "Cuenta Corriente N°: 0-000-9580058-0"
  const m = cuentaCell.match(/N°[:\s]+([\d-]+)/i);
  const displayNumber = m ? m[1] : undefined;
  const accountNumber = displayNumber ? normalizeAccountNumber(displayNumber) : "";

  return {
    bankCode: "SANTANDER",
    accountNumber,
    displayNumber,
    holderName: empresa,
    holderRut: rutEmpresa,
    currency: "CLP",
  };
}

/**
 * Extrae fechas desde una fila tipo "Fecha desde: dd/mm/yyyy" / "Fecha hasta: dd/mm/yyyy".
 * Para CartolaMovimiento esa info está en fila 11 (índice 10).
 */
export function parseSantanderPeriod(
  aoa: unknown[][],
  rowIndex: number
): { periodFrom: Date | null; periodTo: Date | null } {
  const row = aoa[rowIndex] || [];
  let periodFrom: Date | null = null;
  let periodTo: Date | null = null;
  for (const cell of row) {
    const s = asStr(cell);
    const fromMatch = s.match(/desde[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    const toMatch = s.match(/hasta[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (fromMatch) periodFrom = parseDate(fromMatch[1]);
    if (toMatch) periodTo = parseDate(toMatch[1]);
  }
  return { periodFrom, periodTo };
}

/**
 * Glosa típica: "0085668013 Transf. ROHDIS TABILO MARC..."  → "ROHDIS TABILO MARC"
 *               "Transf.Internet a 76.611.709-0"           → null (es solo RUT)
 */
function extractNameFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  // Si tiene un código numérico al inicio, removerlo
  const stripped = glosa.replace(/^0?\d{8,12}[A-Z]?\s+/, "");
  // Quitar prefijo "Transf. " o "Transf de " o "Transf a "
  const m = stripped.match(/^Transf\.?\s*(?:de|a|para)?\s*(.+?)$/i);
  const name = m ? m[1].trim() : stripped.trim();
  // Si lo único que queda es un RUT, devolver null
  if (/^\d{1,9}[-.]\d?[Kk]?$/.test(name)) return null;
  if (!name || name.length < 3) return null;
  return name;
}

function extractRutFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  const m = glosa.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dKk]|\d{7,9}-[\dKk])/);
  return m ? normalizeRut(m[1]) : null;
}
