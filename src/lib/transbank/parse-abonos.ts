import * as XLSX from "xlsx";

/**
 * Parser del reporte de Transbank "Abonos por dia" (.xls/.xlsx).
 *
 * El archivo trae:
 *  - Cabecera con Empresa / RUT / Cuenta corriente destino del abono.
 *  - Un bloque de resumen (Total ventas, comisiones, Total abono).
 *  - Una grilla de detalle: una fila por venta con tarjeta. El header de la
 *    grilla esta en una fila fija-ish; lo ubicamos buscando "Fecha de venta"
 *    + "Total abono", y mapeamos columnas por NOMBRE (tolerante a que se
 *    muevan de posicion entre reportes).
 *
 * Llave para cruzar contra el POS (/api/tbk-tesoreria): el "N° de boleta" del
 * settlement == el N° de OP que viene en la glosa del POS.
 */

export interface TransbankSaleParsed {
  fechaVenta: Date;
  tipoMovimiento: string;
  codigoComercio: string;
  nombreLocal: string;
  medioPago: string;
  montoVenta: number; // bruto (monto original de venta)
  comision: number;
  ivaComision: number;
  totalAbono: number; // neto
  fechaAnulacion: Date | null;
  montoAnulado: number;
  numeroUnico: string;
  tid: string | null;
  codigoAutorizacion: string | null;
  numeroBoleta: string | null; // = OP del POS (sin ceros a la izquierda)
  rawRow: Record<string, unknown>;
}

export interface TransbankAbonosParsed {
  empresaRut: string | null;
  cuentaAbono: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  sales: TransbankSaleParsed[];
  errors: Array<{ rowIndex: number; reason: string }>;
}

const MESES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** "05 junio 2026" | "08 junio" | Date nativo → Date | null */
function parseFecha(v: unknown, fallbackYear?: number): Date | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  const str = s(v);
  if (!str || /^n\/?a$/i.test(str)) return null;
  const m = str.match(/(\d{1,2})\s+([a-záéíóú]+)\s*(\d{4})?/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const mes = MESES[m[2].toLowerCase()];
    const year = m[3] ? parseInt(m[3], 10) : fallbackYear ?? new Date().getFullYear();
    if (mes !== undefined) return new Date(year, mes, day);
  }
  // dd/mm/yyyy
  const m2 = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m2) {
    const y = m2[3].length === 2 ? 2000 + parseInt(m2[3], 10) : parseInt(m2[3], 10);
    return new Date(y, parseInt(m2[2], 10) - 1, parseInt(m2[1], 10));
  }
  return null;
}

/**
 * Parsea un monto tolerando AMBOS formatos de separador, porque el reporte de
 * Transbank llega indistintamente en es-CL ("$350.000" → punto = miles) y en
 * en-US ("$350,000" → coma = miles). Antes asumíamos solo es-CL, así que un
 * "$350,000" se convertía en 350 (÷1000).
 *
 * Regla: el separador DECIMAL es el último "." o "," seguido de 1-2 dígitos al
 * final ("1.234,56" CL / "1,234.56" US). Todo lo demás son separadores de
 * miles. Los montos CLP son enteros, así que si no hay decimal claro, se quitan
 * TODOS los separadores ("350.000" y "350,000" → 350000).
 */
export function parseNum(v: unknown): number {
  let str = s(v).replace(/[$\s]/g, "");
  if (str === "" || /^n\/?a$/i.test(str)) return 0;
  const neg = str.startsWith("-");
  str = str.replace(/[^0-9.,]/g, "");
  const dec = str.match(/[.,](\d{1,2})$/);
  if (dec) {
    str = str.slice(0, -dec[0].length).replace(/[.,]/g, "") + "." + dec[1];
  } else {
    str = str.replace(/[.,]/g, "");
  }
  const n = Number(str);
  if (!Number.isFinite(n)) return 0;
  return Math.round(neg ? -n : n);
}

/** Header → indice de columna, tolerante (incluye substring). */
function buildColMap(headerRow: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((cell, idx) => {
    const label = s(cell).toLowerCase();
    if (label) map.set(label, idx);
  });
  return map;
}

function findCol(colMap: Map<string, number>, ...needles: string[]): number {
  for (const [label, idx] of colMap) {
    for (const n of needles) {
      if (label.includes(n.toLowerCase())) return idx;
    }
  }
  return -1;
}

export function parseTransbankAbonos(buffer: Buffer): TransbankAbonosParsed {
  const wb = XLSX.read(buffer, { cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  // Cabecera: buscar RUT y cuenta corriente en el bloque "Empresa: ... RUT: ..."
  let empresaRut: string | null = null;
  let cuentaAbono: string | null = null;
  let periodFrom: Date | null = null;
  let periodTo: Date | null = null;

  for (let i = 0; i < Math.min(aoa.length, 28); i++) {
    const row = aoa[i] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = s(row[c]);
      const low = cell.toLowerCase();
      if (low === "rut:" || low.startsWith("rut")) {
        // El valor real suele estar en la fila siguiente, misma columna.
        const below = s((aoa[i + 1] ?? [])[c]);
        const rutMatch = below.match(/(\d{1,2}\.\d{3}\.\d{3}-[\dkK]|\d{7,9}-?[\dkK])/);
        if (rutMatch && !empresaRut) empresaRut = rutMatch[1];
      }
      if (low.includes("cuenta corriente")) {
        const below = s((aoa[i + 1] ?? [])[c]);
        if (below && !cuentaAbono) cuentaAbono = below;
      }
      const desde = cell.match(/d[ií]a desde[:\s]*(.+)$/i);
      const hasta = cell.match(/d[ií]a hasta[:\s]*(.+)$/i);
      const periodo = cell.match(/periodo de consulta[:\s]*(.+)$/i);
      if (desde) periodFrom = parseFecha((aoa[i] ?? [])[c + 1]) ?? parseFecha(desde[1]);
      if (hasta) periodTo = parseFecha((aoa[i] ?? [])[c + 1]) ?? parseFecha(hasta[1]);
      if (periodo && !periodFrom) periodFrom = parseFecha((aoa[i] ?? [])[c + 1]);
    }
  }
  const fallbackYear = periodFrom?.getFullYear() ?? periodTo?.getFullYear();

  // Ubicar la fila de header de la grilla: tiene "Fecha de venta" y "Total abono".
  let headerIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    const row = (aoa[i] ?? []).map((c) => s(c).toLowerCase());
    if (row.some((c) => c.includes("fecha de venta")) &&
        row.some((c) => c.includes("total abono"))) {
      headerIdx = i;
    }
  }
  if (headerIdx === -1) {
    return { empresaRut, cuentaAbono, periodFrom, periodTo, sales: [], errors: [{ rowIndex: 0, reason: "No se encontro la grilla de detalle (header 'Fecha de venta'/'Total abono')." }] };
  }

  const colMap = buildColMap(aoa[headerIdx]);
  const C = {
    fecha: findCol(colMap, "fecha de venta"),
    tipo: findCol(colMap, "tipo de movimiento"),
    comercio: findCol(colMap, "codigo de comercio", "código de comercio"),
    local: findCol(colMap, "nombre local"),
    medio: findCol(colMap, "medio de pago"),
    bruto: findCol(colMap, "monto original de venta"),
    comision: findCol(colMap, "comisión transbank (-)", "comision transbank (-)"),
    ivaComision: findCol(colMap, "iva comisión transbank", "iva comision transbank"),
    abono: findCol(colMap, "total abono"),
    fechaAnul: findCol(colMap, "fecha anulación", "fecha anulacion"),
    montoAnul: findCol(colMap, "monto anulado"),
    autoriz: findCol(colMap, "código de autorización de venta", "codigo de autorizacion de venta"),
    numUnico: findCol(colMap, "número único", "numero unico"),
    tid: findCol(colMap, "id transacción (tid)", "id transaccion (tid)"),
    boleta: findCol(colMap, "n° de boleta", "boleta"),
  };

  const sales: TransbankSaleParsed[] = [];
  const errors: TransbankAbonosParsed["errors"] = [];
  const header = aoa[headerIdx].map((c) => s(c));

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    if (row.every((c) => s(c) === "")) continue;
    const fechaVenta = parseFecha(row[C.fecha], fallbackYear);
    if (!fechaVenta) {
      // Fila no-dato (resumen/pie). La saltamos en silencio salvo que tenga monto.
      if (s(row[C.bruto]) !== "") errors.push({ rowIndex: i + 1, reason: "Sin fecha de venta" });
      continue;
    }
    const numeroUnico = s(row[C.numUnico]);
    if (!numeroUnico) {
      errors.push({ rowIndex: i + 1, reason: "Sin número único (no dedupable)" });
      continue;
    }

    const rawRow: Record<string, unknown> = {};
    header.forEach((h, idx) => { rawRow[h || `col_${idx}`] = row[idx] ?? null; });

    const boletaRaw = s(row[C.boleta]);
    const numeroBoleta = boletaRaw.replace(/^0+/, "") || null; // sin ceros; "0000000000" → null

    sales.push({
      fechaVenta,
      tipoMovimiento: s(row[C.tipo]) || "Venta",
      codigoComercio: s(row[C.comercio]),
      nombreLocal: s(row[C.local]),
      medioPago: s(row[C.medio]),
      montoVenta: parseNum(row[C.bruto]),
      comision: parseNum(row[C.comision]),
      ivaComision: parseNum(row[C.ivaComision]),
      totalAbono: parseNum(row[C.abono]),
      fechaAnulacion: parseFecha(row[C.fechaAnul], fallbackYear),
      montoAnulado: parseNum(row[C.montoAnul]),
      numeroUnico,
      tid: s(row[C.tid]) || null,
      codigoAutorizacion: s(row[C.autoriz]) || null,
      numeroBoleta,
      rawRow,
    });
  }

  return { empresaRut, cuentaAbono, periodFrom, periodTo, sales, errors };
}

/**
 * Resuelve la sucursal de un "Nombre local" contra el catalogo conocido
 * (ej. [{id:3,name:"SUECIA"}, ...]). Best-effort: matchea si un token
 * significativo del nombre de sucursal aparece en el nombre local.
 * Devuelve null si no hay match claro (el cruce igual funciona por boleta+monto).
 */
export function resolveSucursal(
  nombreLocal: string,
  catalog: Array<{ id: number; name: string }>,
): number | null {
  const hay = nombreLocal.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  let best: { id: number; score: number } | null = null;
  for (const suc of catalog) {
    if (!suc.name) continue;
    const tokens = suc.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
      .split(/[^A-Z0-9]+/).filter((t) => t.length >= 4);
    const hits = tokens.filter((t) => hay.includes(t)).length;
    if (hits > 0 && (!best || hits > best.score)) best = { id: suc.id, score: hits };
  }
  return best?.id ?? null;
}
