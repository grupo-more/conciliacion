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
 * Banco Internacional - parser único que cubre dos sub-formatos casi idénticos:
 *   - "CartolaProvisoria"  (hoja: "Movimientos entre Fechas")
 *   - "CartolaHistorica"   (hoja: "Cartola Historica")
 *
 * Layout común:
 *   Fila 1: título ("Movimientos entre Fechas" | "Cartola Historica")
 *   Fila 8: "Nº de Cuenta" | | <numero>
 *   Fila 9: "Moneda" | | <moneda>
 *   Fila 10/11: rango de fechas (Provisoria) o "Periodo" (Histórica)
 *   Fila 13/14: bloques de saldos
 *   Fila 17: HEADERS: Fecha | Detalle | Nº Documento | Cargos | Depositos | Saldo
 *           (Provisoria usa "Cheques o Cargos" / "Depositos o Abonos", Histórica usa "Cargos" / "Depositos")
 *   Fila 18+: datos
 */
function makeInternacionalParser(opts: {
  code: "INTERNACIONAL_PROVISORIA" | "INTERNACIONAL_HISTORICA";
  sheetName: string;
  titleA1Includes: string;
}): BankParser {
  return {
    code: opts.code,
    bankCode: "INTERNACIONAL",
    bankName: "Banco Internacional",

    matches(wb) {
      if (!wb.SheetNames.includes(opts.sheetName)) return false;
      const sheet = wb.Sheets[opts.sheetName];
      const a1 = asStr(sheet["A1"]?.v).toLowerCase();
      return a1.includes(opts.titleA1Includes.toLowerCase());
    },

    parse(wb): ParsedStatement {
      const sheet = wb.Sheets[opts.sheetName];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        defval: null,
        raw: false,
      });

      // Fila 8 (índice 7): "Nº de Cuenta" | | número
      const cuentaRaw = asStr(aoa[7]?.[2]);
      const accountNumber = normalizeAccountNumber(cuentaRaw);

      // Periodo: en Provisoria está en filas 10/11 ("Desde" / "Hasta"),
      // en Histórica solo hay "Periodo" tipo "abril 2026" sin fecha exacta.
      let periodFrom: Date | null = null;
      let periodTo: Date | null = null;

      const rowDesde = aoa[9] || [];
      const rowHasta = aoa[10] || [];
      const rowPeriodo = aoa[9] || [];

      const labelDesde = asStr(rowDesde[0]).toLowerCase();
      if (labelDesde === "desde") periodFrom = parseDate(rowDesde[2]);

      const labelHasta = asStr(rowHasta[0]).toLowerCase();
      if (labelHasta === "hasta") periodTo = parseDate(rowHasta[2]);

      if (!periodFrom && !periodTo) {
        // Histórica: "Periodo | | abril 2026" → derivar inicio/fin del mes textual.
        const labelPeriodo = asStr(rowPeriodo[0]).toLowerCase();
        if (labelPeriodo === "periodo") {
          const periodText = asStr(rowPeriodo[2]);
          const range = parseSpanishMonthRange(periodText);
          if (range) {
            periodFrom = range.from;
            periodTo = range.to;
          }
        }
      }

      // Headers en fila 17 (índice 16), datos desde fila 18 (índice 17)
      const headers = (aoa[16] || []).map((h) => asStr(h));
      const movements: NormalizedMovement[] = [];
      const errors: ParsedStatement["errors"] = [];

      for (let i = 17; i < aoa.length; i++) {
        const row = aoa[i];
        if (isEmptyRow(row)) continue;

        try {
          const postDate = parseDate(row[0]);
          const description = asStr(row[1]);
          const nDoc = asStr(row[2]);
          const cargos = parseAmount(row[3]) ?? 0;
          const depositos = parseAmount(row[4]) ?? 0;
          const saldo = parseAmount(row[5]);

          if (!postDate) {
            errors.push({ rowIndex: i + 1, reason: "Sin fecha", raw: row });
            continue;
          }

          let amount: number;
          if (depositos > 0 && cargos === 0) amount = depositos;
          else if (cargos > 0 && depositos === 0) amount = -cargos;
          else if (depositos === 0 && cargos === 0) {
            errors.push({ rowIndex: i + 1, reason: "Movimiento en cero", raw: row });
            continue;
          } else {
            // Caso raro: ambos columnas con valor → priorizar el mayor
            amount = depositos > cargos ? depositos : -cargos;
          }

          const externalId =
            nDoc && /^0+$/.test(nDoc) === false && nDoc.replace(/\D/g, "") !== ""
              ? nDoc.replace(/^0+(?=\d)/, "")
              : null;

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
            branchLabel: null,
            txType: null,
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
        parserCode: opts.code,
        account: {
          bankCode: "INTERNACIONAL",
          accountNumber,
          displayNumber: cuentaRaw || undefined,
          currency: "CLP",
        },
        periodFrom,
        periodTo,
        movements,
        errors,
        metadata: { sheetName: opts.sheetName, headers },
      };
    },
  };
}

export const internacionalProvisoriaParser = makeInternacionalParser({
  code: "INTERNACIONAL_PROVISORIA",
  sheetName: "Movimientos entre Fechas",
  titleA1Includes: "movimientos entre fechas",
});

export const internacionalHistoricaParser = makeInternacionalParser({
  code: "INTERNACIONAL_HISTORICA",
  sheetName: "Cartola Historica",
  titleA1Includes: "cartola historica",
});

const SPANISH_MONTHS: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

function parseSpanishMonthRange(text: string): { from: Date; to: Date } | null {
  if (!text) return null;
  const m = text.toLowerCase().trim().match(/(\w+)\s+(\d{4})/);
  if (!m) return null;
  const month = SPANISH_MONTHS[m[1]];
  if (month === undefined) return null;
  const year = Number(m[2]);
  const from = new Date(year, month, 1);
  const to = new Date(year, month + 1, 0); // último día del mes
  return { from, to };
}

function extractNameFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  // "TRANSF. PARA Vector capital corredores"
  // "Transferencia de otro banco 77333096-4"
  let s = glosa.trim();
  s = s.replace(/^transf(?:erencia)?\.?\s*(?:para|a|de(?:\s+otro\s+banco)?)?\s*/i, "");
  // Remover RUT al final si quedó
  s = s.replace(/\s*\d{7,9}-?[\dKk]\s*$/, "").trim();
  if (!s || s.length < 3) return null;
  return s;
}

function extractRutFromGlosa(glosa: string): string | null {
  if (!glosa) return null;
  const m = glosa.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dKk]|\d{7,9}-[\dKk])/);
  return m ? normalizeRut(m[1]) : null;
}
