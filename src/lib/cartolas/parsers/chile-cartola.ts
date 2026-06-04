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
 * Banco de Chile - "Cartola" formato nuevo (.xls).
 *
 * Layout (distinto al de chile.ts):
 *   Hoja: "Hoja1" (o similar — el detector toma la primera)
 *   Filas 0-6: vacias
 *   Fila 7: ["Sr(a).:", "Alexis Erasmo Figueroa Alarcon"]
 *   Fila 8: ["Nombre Empresa:", "ME SPA"]
 *   Fila 9: ["Rut:", "77.333.096-4"]
 *   Fila 10: ["Cuenta N°:", "00-005-15414-06"]
 *   Fila 11: ["Moneda:", "Pesos Chilenos (CLP)"]
 *   Fila 20: ["Movimientos", "al DD/MM/YYYY"]
 *   Fila 21: HEADERS
 *           Fecha | Descripcion | Canal o Sucursal | Nro. Docto. |
 *           Cargos (CLP) | Abonos (CLP) | Saldo (CLP)
 *   Fila 22+: datos
 *
 * Diferencias clave vs chile.ts:
 *  - Metadata de titular/cuenta en filas separadas (B7-B11), no en A1 inline.
 *  - "Descripcion" en lugar de "Detalle Movimiento".
 *  - "Cargos (CLP)" / "Abonos (CLP)" en lugar de "Cheque o Cargo" / "Deposito o Abono".
 *  - "Canal o Sucursal" como columna unica (antes la cartola vieja tenia "Caja" + "Sucursal" separados).
 *  - Numero de cuenta con guiones ("00-005-15414-06") — al normalizar queda igual
 *    (000051541406) que en el otro formato.
 */
export const chileCartolaParser: BankParser = {
  code: "CHILE_CARTOLA",
  bankCode: "CHILE",
  bankName: "Banco de Chile",

  matches(wb) {
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return false;
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return false;

    // Las metadatas estan en columna B, filas 8-11 aprox. Buscamos la firma
    // "Nombre Empresa:" en columna B en alguna de esas filas, y "Cuenta N°:"
    // en otra. Esto evita falso match contra chile.ts (que tiene "cta:" inline).
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    // Si fila A1 contiene "cta:", es el formato viejo — dejamos pasar.
    const a1 = asStr(aoa[0]?.[0]);
    if (/cta\s*:\s*\d+/i.test(a1)) return false;

    let foundEmpresa = false;
    let foundCuenta = false;
    for (let i = 0; i < Math.min(aoa.length, 25); i++) {
      const row = aoa[i];
      if (!row) continue;
      for (const cell of row) {
        const s = asStr(cell).toLowerCase();
        if (s.startsWith("nombre empresa")) foundEmpresa = true;
        if (s.startsWith("cuenta n")) foundCuenta = true;
      }
    }
    if (!foundEmpresa || !foundCuenta) return false;

    // Verificamos headers "Cargos (CLP)" + "Abonos (CLP)" en alguna fila.
    let foundHeaders = false;
    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
      const row = (aoa[i] ?? []).map((c) => asStr(c).toLowerCase());
      const hasCargos = row.some((c) => c.includes("cargos (clp)"));
      const hasAbonos = row.some((c) => c.includes("abonos (clp)"));
      if (hasCargos && hasAbonos) {
        foundHeaders = true;
        break;
      }
    }
    return foundHeaders;
  },

  parse(wb): ParsedStatement {
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      raw: false,
    });

    // Buscar metadata por etiqueta (no asumimos numero de fila exacto).
    let holderName: string | undefined;
    let holderRut: string | undefined;
    let displayNumber: string | undefined;

    for (const row of aoa.slice(0, 25)) {
      if (!row) continue;
      const label = asStr(row[1]).toLowerCase();
      // El valor suele estar en col D (idx 3) por el merging del template;
      // como fallback tomamos la primera celda no-vacia despues de la etiqueta.
      const value = pickValueAfter(row, 1);
      if (!label || !value) continue;
      if (label.startsWith("nombre empresa")) holderName = value;
      else if (label.startsWith("rut")) holderRut = normalizeRut(value) ?? undefined;
      else if (label.startsWith("cuenta")) displayNumber = value;
    }

    const accountNumber = displayNumber ? normalizeAccountNumber(displayNumber) : "";

    // Encontrar fila de headers (la que tiene "Cargos (CLP)" y "Abonos (CLP)").
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
      const row = (aoa[i] ?? []).map((c) => asStr(c).toLowerCase());
      if (
        row.some((c) => c.includes("cargos (clp)")) &&
        row.some((c) => c.includes("abonos (clp)"))
      ) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx < 0) {
      throw new Error("No se encontraron headers de movimientos");
    }

    const headerRow = (aoa[headerRowIdx] ?? []).map((c) => asStr(c).toLowerCase());
    // Indices de columnas relevantes dentro de la fila de headers.
    const idx = {
      fecha: findCol(headerRow, ["fecha"]),
      descripcion: findCol(headerRow, ["descripci"]),
      canal: findCol(headerRow, ["canal", "sucursal"]),
      nDoc: findCol(headerRow, ["docto"]),
      cargos: findCol(headerRow, ["cargos (clp)"]),
      abonos: findCol(headerRow, ["abonos (clp)"]),
      saldo: findCol(headerRow, ["saldo (clp)", "saldo"]),
    };

    const movements: NormalizedMovement[] = [];
    const errors: ParsedStatement["errors"] = [];

    let periodFrom: Date | null = null;
    let periodTo: Date | null = null;

    for (let i = headerRowIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (isEmptyRow(row)) continue;

      try {
        const postDate = parseDate(row[idx.fecha]);
        const description = asStr(row[idx.descripcion]);
        const cargo = parseAmount(row[idx.cargos]) ?? 0;
        const abono = parseAmount(row[idx.abonos]) ?? 0;
        const saldo = parseAmount(row[idx.saldo]);
        const canal = idx.canal >= 0 ? asStr(row[idx.canal]) : "";
        const nDoc = idx.nDoc >= 0 ? asStr(row[idx.nDoc]) : "";

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
          amount = abono > cargo ? abono : -cargo;
        }

        const externalId =
          nDoc && /^0+$/.test(nDoc) === false && nDoc.replace(/\D/g, "") !== ""
            ? nDoc.replace(/^0+(?=\d)/, "")
            : null;

        if (!periodFrom || postDate < periodFrom) periodFrom = postDate;
        if (!periodTo || postDate > periodTo) periodTo = postDate;

        const rawRow: Record<string, unknown> = {};
        headerRow.forEach((h, j) => {
          rawRow[h || `col_${j}`] = row[j] ?? null;
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
          branchLabel: canal || null,
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
      parserCode: "CHILE_CARTOLA",
      account: {
        bankCode: "CHILE",
        accountNumber,
        displayNumber,
        holderName,
        holderRut,
        currency: "CLP",
      },
      periodFrom,
      periodTo,
      movements,
      errors,
      metadata: { sheetName, headerRowIdx, headers: headerRow },
    };
  },
};

/**
 * Busca la primera celda no-vacia despues del indice `afterIdx`.
 * En el template de Chile, la etiqueta esta en B y el valor cae en D (col 3)
 * por merging — esta funcion lo encuentra sin asumir la columna exacta.
 */
function pickValueAfter(row: unknown[], afterIdx: number): string {
  for (let j = afterIdx + 1; j < row.length; j++) {
    const v = asStr(row[j]);
    if (v) return v;
  }
  return "";
}

/**
 * Devuelve el indice de la primera columna del header que matchea cualquiera
 * de las keywords (substring case-insensitive). -1 si ninguna calza.
 */
function findCol(headerRow: string[], keywords: string[]): number {
  for (let j = 0; j < headerRow.length; j++) {
    const h = headerRow[j];
    if (keywords.some((kw) => h.includes(kw))) return j;
  }
  return -1;
}

/**
 * Extrae nombre de contraparte de glosas tipo "Traspaso De: Me Spa" /
 * "Traspaso A: Sonia". Igual logica que chile.ts.
 */
function extractCounterpartyName(glosa: string): string | null {
  if (!glosa) return null;
  const m = glosa.match(/^Traspaso\s+(?:A|De|De:|A:)\s*:?\s*(.+?)$/i);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name.length < 3) return null;
  return name;
}
