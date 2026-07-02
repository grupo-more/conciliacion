"use client";

import { exportAsi1Xls, type Asi1Options } from "@/lib/asientos/exportAsi1";

/**
 * Vista previa + impresión del asiento en formato ASI1 (el mismo que se descarga
 * a Excel para gestión). Reutilizado por todas las tabs de asiento.
 *
 * - Preview: muestra la cabecera y el detalle tal como saldrá (fecha dd-mm-yyyy,
 *   montos con miles y "0" en el cero, ME = MN).
 * - Imprimir: abre una ventana con el asiento en HTML limpio y dispara la impresión.
 * - Descargar Excel: genera el .xls ASI1.
 */

interface DisplayRow {
  linea: number;
  rubro: string;
  cliente: string;
  detalle: string;
  cotizacion: string;
  debeME: string;
  haberME: string;
  debeMN: string;
  haberMN: string;
}

function num(v: number | string | null | undefined): number {
  if (v == null || v === "") return 0;
  return typeof v === "number" ? v : Number(v);
}

const nf = new Intl.NumberFormat("es-CL");
function money(n: number): string {
  return n === 0 ? "0" : nf.format(n);
}

function fechaDisplay(f: Date | string): string {
  const s =
    typeof f === "string"
      ? f.slice(0, 10)
      : `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}-${String(
          f.getDate(),
        ).padStart(2, "0")}`;
  const [y, m, d] = s.split("-");
  return `${d}-${m}-${y}`;
}

function toRows(o: Asi1Options): DisplayRow[] {
  return o.lineas.map((l, i) => {
    const debe = num(l.debe);
    const haber = num(l.haber);
    return {
      linea: i + 1,
      rubro: String(l.rubro ?? ""),
      cliente: String(l.cliente ?? 0),
      detalle: l.detalle,
      cotizacion: "1",
      // ME = MN (cotización 1, todo CLP).
      debeME: money(debe),
      haberME: money(haber),
      debeMN: money(debe),
      haberMN: money(haber),
    };
  });
}

function totals(o: Asi1Options): { debe: number; haber: number; cuadra: boolean } {
  let debe = 0;
  let haber = 0;
  for (const l of o.lineas) {
    debe += num(l.debe);
    haber += num(l.haber);
  }
  return { debe, haber, cuadra: debe === haber };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c);
}

/** Abre una ventana con el asiento en HTML e imprime. */
export function printAsi1(o: Asi1Options) {
  const w = window.open("", "_blank");
  if (!w) {
    alert("Habilitá las ventanas emergentes para imprimir.");
    return;
  }
  const rows = toRows(o);
  const t = totals(o);
  const sucursal = o.sucursal ?? 1;
  const tipo = o.tipoAsiento ?? 0;
  const estado = o.estado ?? "CON";
  const body = rows
    .map(
      (r) => `<tr>
        <td class="c">${r.linea}</td>
        <td class="c">${esc(r.rubro)}</td>
        <td class="c">${esc(r.cliente)}</td>
        <td>${esc(r.detalle)}</td>
        <td class="c">${r.cotizacion}</td>
        <td class="n">${r.debeME}</td>
        <td class="n">${r.haberME}</td>
        <td class="n">${r.debeMN}</td>
        <td class="n">${r.haberMN}</td>
      </tr>`,
    )
    .join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Asiento</title>
    <style>
      * { font-family: Arial, sans-serif; }
      body { padding: 24px; color: #111; }
      h1 { font-size: 16px; margin: 0 0 12px; }
      .hdr { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 4px 16px; font-size: 12px; margin-bottom: 16px; }
      .hdr b { font-weight: 700; }
      table { border-collapse: collapse; width: 100%; font-size: 12px; }
      th, td { border: 1px solid #999; padding: 3px 6px; }
      th { background: #f0f0f0; text-align: left; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; }
      td.c { text-align: center; }
      tfoot td { font-weight: 700; background: #f7f7f7; }
      .cuadra { color: #0a7d3a; } .descuadre { color: #c0392b; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <h1>Importación asiento a gestión</h1>
    <div class="hdr">
      <b>FECHA:</b><span>${fechaDisplay(o.fecha)}</span>
      <b>Tipo de Asiento:</b><span>${tipo}</span>
      <b>Descripción:</b><span>${esc(o.descripcion)}</span>
      <b>Sucursal:</b><span>${sucursal}</span>
      <b>Estado:</b><span>${esc(estado)}</span>
    </div>
    <table>
      <thead><tr>
        <th>Línea</th><th>Rubro</th><th>Cliente</th><th>Descripción</th>
        <th>Cotización</th><th>Debe ME</th><th>Haber ME</th><th>Debe MN</th><th>Haber MN</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td colspan="7" style="text-align:right">TOTAL</td>
        <td class="n">${money(t.debe)}</td>
        <td class="n">${money(t.haber)}</td>
      </tr></tfoot>
    </table>
    <p style="font-size:12px" class="${t.cuadra ? "cuadra" : "descuadre"}">
      ${t.cuadra ? "✔ Cuadra" : "⚠ Descuadre: Debe ≠ Haber"}
    </p>
    <script>window.onload = function(){ window.print(); }</script>
    </body></html>`);
  w.document.close();
}

export function Asi1PreviewModal({
  options,
  filename,
  onClose,
}: {
  options: Asi1Options;
  filename: string;
  onClose: () => void;
}) {
  const rows = toRows(options);
  const t = totals(options);
  const sucursal = options.sucursal ?? 1;
  const tipo = options.tipoAsiento ?? 0;
  const estado = options.estado ?? "CON";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Vista previa · asiento a gestión</h2>
          <div className="flex gap-2">
            <button onClick={() => printAsi1(options)} className="btn-ghost text-sm">
              Imprimir
            </button>
            <button
              onClick={() => exportAsi1Xls(options, filename)}
              className="rounded-md bg-brand text-white text-sm font-semibold px-3 py-1.5 hover:opacity-90"
            >
              Descargar Excel
            </button>
            <button onClick={onClose} className="btn-ghost text-sm">
              Cerrar
            </button>
          </div>
        </div>

        {/* Cabecera */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm mb-3 rounded-md border border-border-soft bg-bg-soft/40 p-3">
          <div>
            <span className="text-text-muted">Fecha:</span> <b>{fechaDisplay(options.fecha)}</b>
          </div>
          <div>
            <span className="text-text-muted">Sucursal:</span> <b>{sucursal}</b>
          </div>
          <div className="col-span-2">
            <span className="text-text-muted">Descripción:</span> {options.descripcion}
          </div>
          <div>
            <span className="text-text-muted">Tipo de asiento:</span> {tipo}
          </div>
          <div>
            <span className="text-text-muted">Estado:</span> {estado}
          </div>
        </div>

        {/* Detalle */}
        <div className="overflow-x-auto max-h-[55vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted sticky top-0">
              <tr>
                <th className="px-2 py-1.5 text-center">Línea</th>
                <th className="px-2 py-1.5 text-center">Rubro</th>
                <th className="px-2 py-1.5 text-center">Cliente</th>
                <th className="px-2 py-1.5 text-left">Descripción</th>
                <th className="px-2 py-1.5 text-center">Cotiz.</th>
                <th className="px-2 py-1.5 text-right">Debe ME</th>
                <th className="px-2 py-1.5 text-right">Haber ME</th>
                <th className="px-2 py-1.5 text-right">Debe MN</th>
                <th className="px-2 py-1.5 text-right">Haber MN</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.linea} className="border-t border-border-soft/60">
                  <td className="px-2 py-1 text-center">{r.linea}</td>
                  <td className="px-2 py-1 text-center font-mono">{r.rubro}</td>
                  <td className="px-2 py-1 text-center">{r.cliente}</td>
                  <td className="px-2 py-1">{r.detalle}</td>
                  <td className="px-2 py-1 text-center">{r.cotizacion}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.debeME}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.haberME}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.debeMN}</td>
                  <td className="px-2 py-1 text-right font-mono">{r.haberMN}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border-soft font-semibold bg-bg-soft/50">
                <td colSpan={7} className="px-2 py-1.5 text-right">
                  TOTAL
                </td>
                <td className="px-2 py-1.5 text-right font-mono">{money(t.debe)}</td>
                <td className="px-2 py-1.5 text-right font-mono">{money(t.haber)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div
          className={`mt-2 text-sm font-semibold ${t.cuadra ? "text-emerald-700" : "text-rose-700"}`}
        >
          {t.cuadra ? "✔ Cuadra" : "⚠ Descuadre: Debe ≠ Haber"}
        </div>
      </div>
    </div>
  );
}
