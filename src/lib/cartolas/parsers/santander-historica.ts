import * as XLSX from "xlsx";
import type { BankParser, NormalizedMovement, ParsedStatement } from "../types";
import {
  asStr,
  isEmptyRow,
  parseAmount,
  parseDate,
} from "../normalize";
import {
  parseSantanderAccountInfo,
  parseSantanderSaldoFinal,
} from "./santander-movimiento";

/**
 * Santander - "Cartola Histórica CtaCte" (cartola mensual).
 *
 * Layout:
 *   Hoja: "Cartola Historica CtaCte"
 *   Fila 1: "Cartolas históricas de Cuentas Corrientes..."
 *   Fila 3: "Sr. (a):" | nombre | | "Fecha:" | fecha
 *   Fila 4: "Empresa:" | nombre empresa
 *   Fila 5: "RUT empresa:" | rut
 *   Fila 7: "Cuenta Corriente N°: 0-000-XXXXXXX-X" | | "Moneda" | "Sucursal"
 *   Fila 8: "Número cartola: 24" | | "Fecha desde: dd/mm/yyyy" | "Fecha hasta: dd/mm/yyyy"
 *   Filas 9-14: bloque "Saldos" e "Información línea de crédito"
 *   Fila 15: "Detalle movimientos"
 *   Fila 16: HEADERS: MONTO | DESCRIPCIÓN | (vacía) | FECHA | N° DOCUMENTO | SUCURSAL | (vacía) | CARGO/ABONO
 *   Fila 17+: datos
 *
 * Diferencias vs Movimiento:
 *  - 8 columnas (con 2 vacías intercaladas)
 *  - NO trae saldo por movimiento
 *  - N° DOCUMENTO suele venir con valor real (mejor que Movimiento)
 */
export const santanderHistoricaParser: BankParser = {
  code: "SANTANDER_HISTORICA",
  bankCode: "SANTANDER",
  bankName: "Santander",

  matches(wb) {
    return wb.SheetNames.includes("Cartola Historica CtaCte");
  },

  parse(wb): ParsedStatement {
    const sheetName = "Cartola Historica CtaCte";
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

    // Headers en fila 16 (índice 15), datos desde fila 17 (índice 16)
    const headers = (aoa[15] || []).map((h) => asStr(h));
    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    for (let i = 16; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      // Cortar al llegar al bloque "Saldos diarios" (cierra la lista de movimientos).
      const col0 = asStr(row[0]).toLowerCase();
      if (col0.includes("saldos diarios")) break;

      // Saltar silenciosamente headers de bloques intermedios (ej. "Resumen comisiones",
      // re-impresión de la fila de headers "MONTO | DESCRIPCIÓN | ...").
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
          // Si no hay fecha y col 0 no es numérico, es header/título de bloque → skip silent.
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
      parserCode: "SANTANDER_HISTORICA",
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
 * Aplica el saldo final del header como balanceAfter del movimiento con la
 * fecha más reciente del archivo (en caso de empate, el último en orden de
 * lectura — que corresponde al cierre del período).
 */
export function applySaldoFinalToLatestMovement(
  movements: NormalizedMovement[],
  saldoFinal: number | null
): void {
  if (saldoFinal === null || movements.length === 0) return;
  let bestIdx = 0;
  let bestTime = movements[0].postDate.getTime();
  for (let i = 1; i < movements.length; i++) {
    const t = movements[i].postDate.getTime();
    if (t >= bestTime) {
      bestTime = t;
      bestIdx = i;
    }
  }
  movements[bestIdx].balanceAfter = saldoFinal;
}

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
  // Reusar normalizeRut a través del valor
  return m[1].toUpperCase().replace(/\./g, "");
}
