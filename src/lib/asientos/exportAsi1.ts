import * as XLSX from "xlsx";

/**
 * Exportador al formato "Importación asiento a gestión" (hoja ASI1).
 *
 * Replica EXACTAMENTE el layout del archivo de ejemplo que usa gestión:
 * cabecera en celdas fijas + detalle desde la fila 11, escrito como .xls
 * binario (BIFF8) — mismo formato OLE que el ejemplo, no .xlsx moderno.
 *
 *   Fila 1  A..M = 1..13 (guía posicional)
 *   Fila 2  B "FECHA:"  C <serial>   F "Tipo de Asiento" G <tipo>   I "Sucursal:" J <suc>
 *   Fila 4  B "Descripcion del asiento"  E <descripción>   I "Estado" J <estado>
 *   Fila 10 encabezados del detalle
 *   Fila 11+ líneas del asiento
 *
 * Columnas del detalle:
 *   A Linea | B Rubro de gestion | C cliente | D Descripción |
 *   F Cotización | G Debe ME | H Haber ME | I Debe MN | J Haber MN
 */

export interface Asi1Linea {
  /** Rubro contable de gestión. */
  rubro: number | string;
  /** Descripción de la línea. */
  detalle: string;
  /** Monto al debe en moneda nacional (CLP). null/0 si va al haber. */
  debe?: number | string | null;
  /** Monto al haber en moneda nacional (CLP). null/0 si va al debe. */
  haber?: number | string | null;
  /** Cliente (RUT/código). Por defecto 0. */
  cliente?: number | string;
}

export interface Asi1Options {
  /** Fecha del asiento (Date o "YYYY-MM-DD"). */
  fecha: Date | string;
  /** Texto que va en "Descripcion del asiento". */
  descripcion: string;
  /** Sucursal del encabezado. Default 1. */
  sucursal?: number;
  /** Tipo de asiento. Default 0. */
  tipoAsiento?: number;
  /** Estado. Default "CON". */
  estado?: string;
  /** Líneas del asiento (detalle). */
  lineas: Asi1Linea[];
}

/** Días entre 1899-12-30 (epoch de Excel) y 1970-01-01. */
const EXCEL_EPOCH_OFFSET = 25569;

/** Convierte una fecha a número de serie de Excel (como en el ejemplo). */
function toExcelSerial(fecha: Date | string): number {
  let y: number, m: number, d: number;
  if (typeof fecha === "string") {
    const [ys, ms, ds] = fecha.slice(0, 10).split("-").map(Number);
    y = ys;
    m = ms;
    d = ds;
  } else {
    y = fecha.getFullYear();
    m = fecha.getMonth() + 1;
    d = fecha.getDate();
  }
  const ms = Date.UTC(y, m - 1, d);
  return Math.floor(ms / 86_400_000) + EXCEL_EPOCH_OFFSET;
}

/** Normaliza un monto (string/number/null) a number; 0 si vacío. */
function num(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  return typeof v === "number" ? v : Number(v);
}

/**
 * Genera y descarga el .xls con el layout ASI1 exacto que importa gestión.
 * @param opts   Datos de cabecera + líneas del asiento.
 * @param filename Nombre del archivo SIN extensión (se agrega .xls).
 */
export function exportAsi1Xls(opts: Asi1Options, filename: string): void {
  const { fecha, descripcion, lineas } = opts;
  const sucursal = opts.sucursal ?? 1;
  const tipoAsiento = opts.tipoAsiento ?? 0;
  const estado = opts.estado ?? "CON";

  const ws: XLSX.WorkSheet = {};
  const set = (
    addr: string,
    v: string | number,
    t: "s" | "n" = typeof v === "number" ? "n" : "s",
  ) => {
    ws[addr] = { t, v } as XLSX.CellObject;
  };

  // Fila 1: numeración de columnas 1..13 (A..M)
  for (let c = 0; c < 13; c++) {
    set(XLSX.utils.encode_cell({ r: 0, c }), c + 1, "n");
  }
  // Fila 2: FECHA / Tipo de Asiento / Sucursal
  set("B2", "FECHA:");
  set("C2", toExcelSerial(fecha), "n");
  set("F2", "Tipo de Asiento");
  set("G2", tipoAsiento, "n");
  set("I2", "Sucursal:");
  set("J2", sucursal, "n");
  // Fila 4: Descripción / Estado
  set("B4", "Descripcion del asiento");
  set("E4", descripcion);
  set("I4", "Estado");
  set("J4", estado);
  // Fila 10: encabezados del detalle
  set("A10", "Linea");
  set("B10", "Rubro de gestion");
  set("C10", "cliente");
  set("D10", "Descripción");
  set("F10", "Cotización");
  set("G10", "Debe ME");
  set("H10", "Haber ME");
  set("I10", "Debe MN");
  set("J10", "Haber MN");

  // Detalle desde fila 11
  let row = 10; // 0-indexed → fila 11
  lineas.forEach((l, i) => {
    const r = row + i;
    const rr = r + 1;
    set(`A${rr}`, i + 1, "n");
    set(`B${rr}`, l.rubro);
    set(`C${rr}`, l.cliente ?? 0, "n");
    set(`D${rr}`, l.detalle);
    set(`F${rr}`, 1, "n"); // Cotización
    set(`G${rr}`, 0, "n"); // Debe ME
    set(`H${rr}`, 0, "n"); // Haber ME
    set(`I${rr}`, num(l.debe), "n"); // Debe MN
    set(`J${rr}`, num(l.haber), "n"); // Haber MN
  });
  const lastRow = row + Math.max(lineas.length, 1);

  ws["!ref"] = `A1:S${lastRow}`;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "ASI1");
  XLSX.writeFile(wb, `${filename}.xls`, { bookType: "biff8" });
}
