import * as XLSX from "xlsx";
import type { BankParser, NormalizedMovement, ParsedStatement } from "../types";
import {
  asStr,
  isEmptyRow,
  normalizeRut,
  parseAmount,
  parseDate,
} from "../normalize";
import {
  parseSantanderAccountInfo,
  parseSantanderSaldoFinal,
} from "./santander-movimiento";
import { applySaldoFinalToLatestMovement } from "./santander-historica";

/**
 * Santander - "Cartola Provisoria Cta. Cte. y Líneas de Crédito"
 * (cartola mensual provisoria del mes en curso).
 *
 * Layout:
 *   Hoja: "CartolaProvisoria"
 *   Fila 1: "Cartola provisoria Cta. Cte. y Líneas de Crédito"
 *   Fila 3: "Sr. (a):" | nombre | | "Fecha:" | fecha
 *   Fila 4: "Empresa:" | nombre empresa | | "Hora:" | hora
 *   Fila 5: "RUT empresa:" | rut
 *   Fila 7: "Cuenta 0-000-XXXXXXX-X" | | "Moneda: ..." | "Sucursal: ..."
 *   Fila 8: "Número cartola: 25" | | "Fecha desde: dd/mm/yyyy" | "Fecha hasta: dd/mm/yyyy"
 *   Filas 9-11: bloque "Saldos" (3 filas, más corto que la Histórica)
 *   Fila 12: "Detalle movimientos"
 *   Fila 13: HEADERS: MONTO | DESCRIPCIÓN | (vacía) | FECHA | N° DOCUMENTO | SUCURSAL | (vacía) | CARGO/ABONO
 *   Fila 14+: datos
 *
 * Diferencias vs Histórica:
 *  - Hoja "CartolaProvisoria" (sin espacios, sin "CtaCte")
 *  - Línea de cuenta sin "N°:" → "Cuenta 0-000-XXXXXXX-X"
 *  - Bloque de saldos 3 filas más corto (no incluye "Información línea de crédito")
 *  - Headers en fila 13, datos en fila 14
 */
export const santanderProvisoriaParser: BankParser = {
  code: "SANTANDER_PROVISORIA",
  bankCode: "SANTANDER",
  bankName: "Santander",

  matches(wb) {
    if (!wb.SheetNames.includes("CartolaProvisoria")) return false;
    const sheet = wb.Sheets["CartolaProvisoria"];
    const a1 = asStr(sheet["A1"]?.v).toLowerCase();
    return a1.includes("cartola provisoria");
  },

  parse(wb): ParsedStatement {
    const sheetName = "CartolaProvisoria";
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    const account = parseSantanderAccountInfo(aoa);

    // Periodo en fila 8 (índice 7)
    const row8 = aoa[7] || [];
    let periodFrom: Date | null = null;
    let periodTo: Date | null = null;
    for (const cell of row8) {
      const s = asStr(cell);
      const fromMatch = s.match(/desde[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      const toMatch = s.match(/hasta[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (fromMatch) periodFrom = parseDate(fromMatch[1]);
      if (toMatch) periodTo = parseDate(toMatch[1]);
    }

    // Headers en fila 13 (índice 12), datos desde fila 14 (índice 13)
    const headers = (aoa[12] || []).map((h) => asStr(h));
    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    for (let i = 13; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      // Cortar al llegar al bloque "Saldos diarios" (cierra la lista de movimientos).
      const col0 = asStr(row[0]).toLowerCase();
      if (col0.includes("saldos diarios")) break;

      // Saltar silenciosamente headers de bloques intermedios.
      if (
        col0 === "" ||
        col0 === "monto" ||
        col0.includes("resumen") ||
        col0 === "saldo"
      ) {
        const c1 = asStr(row[1]).toLowerCase();
        if (c1.includes("descripción") || c1.includes("descripcion") || col0 !== "") {
          continue;
        }
      }

      try {
        const monto = parseAmount(row[0]);
        const description = asStr(row[1]);
        const postDate = parseDate(row[3]);
        const nDoc = asStr(row[4]);
        const sucursal = asStr(row[5]) || null;
        const cargoAbono = asStr(row[7]).toUpperCase();

        if (!postDate) {
          if (monto === null) continue;
          errors.push({ rowIndex: i + 1, reason: "Sin fecha", raw: row });
          continue;
        }
        if (monto === null) {
          errors.push({ rowIndex: i + 1, reason: "Sin monto", raw: row });
          continue;
        }

        let amount = monto;
        if (cargoAbono === "C" && amount > 0) amount = -amount;
        if (cargoAbono === "A" && amount < 0) amount = Math.abs(amount);

        const externalId =
          nDoc && /^0+$/.test(nDoc) === false && nDoc.replace(/\D/g, "") !== ""
            ? nDoc.replace(/^0+(?=\d)/, "")
            : null;

        const counterpartyRut = extractRutFromGlosa(description);
        const counterpartyName = extractNameFromGlosa(description);

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
          balanceAfter: null,
          counterpartyName,
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

    // El archivo no trae saldo por movimiento, pero sí "SALDO FINAL" en el
    // bloque de saldos (fila 11). Lo aplicamos al movimiento más reciente del
    // import para que el dashboard pueda mostrar el saldo de la cuenta.
    applySaldoFinalToLatestMovement(movements, parseSantanderSaldoFinal(aoa));

    return {
      parserCode: "SANTANDER_PROVISORIA",
      account,
      periodFrom,
      periodTo,
      movements,
      errors,
      metadata: { sheetName, headers },
    };
  },
};

function extractNameFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  const stripped = glosa.replace(/^0?\d{8,12}[A-Z]?\s+/, "");
  const m = stripped.match(/^Transf\.?\s*(?:de|a|para)?\s*(.+?)$/i);
  const name = m ? m[1].trim() : stripped.trim();
  if (/^\d{1,9}[-.]\d?[Kk]?$/.test(name)) return null;
  if (!name || name.length < 3) return null;
  return name;
}

function extractRutFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  const m = glosa.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dKk]|\d{7,9}-[\dKk])/);
  if (!m) return null;
  return normalizeRut(m[1]);
}
