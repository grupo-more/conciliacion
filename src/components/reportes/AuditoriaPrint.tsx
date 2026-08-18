"use client";

import { formatMoney, formatDate } from "@/lib/format";

/**
 * Genera el informe de Auditoría de cuadre (una o varias cuentas) e imprime
 * vía el diálogo del navegador (mismo patrón que printAsi1 en
 * consolidados/Asi1Preview.tsx) — sin agregar ninguna librería de PDF nueva.
 * "Guardar como PDF" desde ese diálogo cumple la exportación.
 */

interface AccountLite {
  bankCode: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  displayNumber: string | null;
}

interface SaldoManualDTO {
  fecha: string;
  monto: string;
  nota: string | null;
  capturadoPor: string;
}

interface PendienteBancoRow {
  fecha: string;
  direction: "IN" | "OUT";
  monto: string;
  counterpartyName: string | null;
  description: string | null;
}

interface PendienteDynatechRow {
  fecha: string;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  clienteName: string | null;
  glosa: string;
}

interface CuentaAuditoria {
  account: AccountLite;
  saldoManual: SaldoManualDTO | null;
  saldoSistema: string | null;
  diferencia: string | null;
  pendientes: {
    bancoSinDynatech: { count: number; monto: string; neto: string; rows?: PendienteBancoRow[] };
    dynatechSinBanco: { count: number; monto: string; neto: string; rows?: PendienteDynatechRow[] };
  } | null;
  sumaPendientesNeta: string | null;
  diferenciaSinExplicar: string | null;
  cuadra: boolean | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cuentaLabel(a: AccountLite): string {
  return `${esc(a.bankName)} · ${esc(a.holderName)} · ${esc(a.displayNumber || a.accountNumber)}`;
}

function money(v: string | null | undefined): string {
  // Tolera undefined (campo ausente), no solo null: BigInt(undefined) lanza.
  if (v === null || v === undefined) return "—";
  return formatMoney(BigInt(v));
}

export function printAuditoriaCuenta(cuentas: CuentaAuditoria[]) {
  const w = window.open("", "_blank", "width=1000,height=800");
  if (!w) return;

  const secciones = cuentas.map((c) => seccionCuenta(c)).join("\n<hr/>\n");

  w.document.write(`<!doctype html><html><head><meta charset="utf-8">
    <title>Auditoría de cuadre</title>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; padding: 24px; color: #222; }
      h1 { font-size: 16px; margin-bottom: 4px; }
      h2 { font-size: 13px; margin: 0 0 2px; }
      .sub { color: #666; margin-bottom: 10px; }
      .stats { display: flex; gap: 18px; margin: 10px 0 14px; flex-wrap: wrap; }
      .stat { min-width: 140px; }
      .stat .lbl { font-size: 10px; text-transform: uppercase; color: #888; letter-spacing: .04em; }
      .stat .val { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
      table { border-collapse: collapse; width: 100%; margin: 6px 0 16px; }
      th, td { border: 1px solid #ccc; padding: 3px 6px; font-size: 11px; }
      th { background: #f0f0f0; text-align: left; }
      td.n { text-align: right; font-variant-numeric: tabular-nums; }
      td.c { text-align: center; }
      .cuadra { color: #0a7d3a; font-weight: 700; }
      .descuadre { color: #c0392b; font-weight: 700; }
      .sindato { color: #888; }
      hr { border: none; border-top: 2px solid #ddd; margin: 22px 0; }
      @media print { hr { page-break-after: always; border: none; } }
    </style></head><body>
    <h1>Auditoría de cuadre</h1>
    <div class="sub">Generado ${formatDate(new Date().toISOString())}</div>
    ${secciones}
    <script>window.onload = function(){ window.print(); }</script>
    </body></html>`);
  w.document.close();
}

function seccionCuenta(c: CuentaAuditoria): string {
  const estado = c.cuadra === null
    ? '<span class="sindato">Sin saldo manual cargado</span>'
    : c.cuadra
      ? '<span class="cuadra">✔ Cuadra</span>'
      : `<span class="descuadre">⚠ Diferencia sin explicar: ${esc(money(c.diferenciaSinExplicar))}</span>`;

  const stats = `
    <div class="stats">
      <div class="stat"><div class="lbl">Saldo Banco${c.saldoManual ? ` (${esc(formatDate(c.saldoManual.fecha))})` : ""}</div><div class="val">${esc(money(c.saldoSistema))}</div></div>
      <div class="stat"><div class="lbl">Saldo manual</div><div class="val">${esc(money(c.saldoManual?.monto ?? null))}</div></div>
      <div class="stat"><div class="lbl">Diferencia</div><div class="val">${esc(money(c.diferencia))}</div></div>
      <div class="stat"><div class="lbl">Pendientes (neto)</div><div class="val">${esc(money(c.sumaPendientesNeta))}</div></div>
    </div>`;

  const bancoRows = c.pendientes?.bancoSinDynatech.rows ?? [];
  const dynaRows = c.pendientes?.dynatechSinBanco.rows ?? [];

  const bancoTabla = c.pendientes
    ? `<h2>Bancos sin Dynatech (${c.pendientes.bancoSinDynatech.count}) — neto ${esc(money(c.pendientes.bancoSinDynatech.neto))}</h2>
       ${bancoRows.length === 0 ? "<p>Sin pendientes de este lado.</p>" : `
       <table><thead><tr><th>Fecha</th><th>Dir.</th><th>Monto</th><th>Contraparte</th><th>Glosa</th></tr></thead>
       <tbody>${bancoRows
         .map(
           (r) =>
             `<tr><td>${esc(formatDate(r.fecha))}</td><td class="c">${r.direction}</td><td class="n">${esc(
               formatMoney(BigInt(r.monto)),
             )}</td><td>${esc(r.counterpartyName ?? "—")}</td><td>${esc(r.description ?? "")}</td></tr>`,
         )
         .join("")}</tbody></table>`}`
    : "";

  const dynaTabla = c.pendientes
    ? `<h2>Dynatech sin banco (${c.pendientes.dynatechSinBanco.count}) — neto ${esc(money(c.pendientes.dynatechSinBanco.neto))}</h2>
       ${dynaRows.length === 0 ? "<p>Sin pendientes de este lado.</p>" : `
       <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Monto</th><th>Cliente</th><th>Glosa</th></tr></thead>
       <tbody>${dynaRows
         .map(
           (r) =>
             `<tr><td>${esc(formatDate(r.fecha))}</td><td class="c">${r.tipoOperacion}</td><td class="n">${esc(
               formatMoney(BigInt(r.monto)),
             )}</td><td>${esc(r.clienteName ?? "—")}</td><td>${esc(r.glosa)}</td></tr>`,
         )
         .join("")}</tbody></table>`}`
    : "";

  return `<h1 style="font-size:14px">${cuentaLabel(c.account)}</h1>
    <div class="sub">${estado}</div>
    ${stats}
    ${bancoTabla}
    ${dynaTabla}`;
}
