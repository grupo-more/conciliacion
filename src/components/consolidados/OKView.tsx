"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";
import type { OKResponse, OKRow } from "./types";

/**
 * Tab "OK" de Consolidados: muestra los conciliados (AUTO_MATCHED + MANUAL)
 * como asiento contable de partida doble, con exportación a Excel.
 */
export function OKView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [rubroSucursal, setRubroSucursal] = useState<string>("");

  const [data, setData] = useState<OKResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (accountId) p.set("accountId", accountId);
      if (rubroSucursal) p.set("rubroSucursal", rubroSucursal);
      const res = await fetch(`/api/consolidados/ok?${p}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, accountId, rubroSucursal]);

  const totals = useMemo(() => {
    if (!data) return { debe: 0n, haber: 0n };
    return {
      debe: BigInt(data.totals.debe),
      haber: BigInt(data.totals.haber),
    };
  }, [data]);

  function exportXlsx() {
    if (!data || data.rows.length === 0) return;
    const aoa: (string | number)[][] = [
      ["Fecha", "Rubro", "Detalle", "Cliente", "Glosa", "Debe", "Haber"],
    ];
    for (const r of data.rows) {
      aoa.push([
        formatDate(r.fecha),
        r.rubro ?? "—",
        r.detalle,
        r.cliente,
        r.glosa,
        r.debe ? Number(r.debe) : "",
        r.haber ? Number(r.haber) : "",
      ]);
    }
    aoa.push([
      "",
      "",
      "",
      "",
      "TOTAL",
      Number(totals.debe),
      Number(totals.haber),
    ]);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    // Anchos sugeridos
    sheet["!cols"] = [
      { wch: 12 }, // Fecha
      { wch: 8 }, // Rubro
      { wch: 22 }, // Detalle
      { wch: 32 }, // Cliente
      { wch: 40 }, // Glosa
      { wch: 14 }, // Debe
      { wch: 14 }, // Haber
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Asiento");
    const fname = `asiento_${from}_${to}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  const hasRows = data && data.rows.length > 0;

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Desde</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las cuentas</option>
          {data?.facets.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <select
          value={rubroSucursal}
          onChange={(e) => setRubroSucursal(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las sucursales</option>
          {data?.facets.rubrosSucursales.map((r) => (
            <option key={r.rubro} value={String(r.rubro)}>
              {r.rubro} {r.label ? `— ${r.label}` : ""}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={exportXlsx}
          disabled={!hasRows}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          Descargar Excel
        </button>
      </div>

      {/* Tabla */}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">
            Cargando…
          </div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            No hay conciliados en este rango.
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Rubro</th>
                  <th className="px-3 py-2 text-left">Detalle</th>
                  <th className="px-3 py-2 text-left">Cliente</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const prev = idx > 0 ? data!.rows[idx - 1] : null;
                  const isGroupStart = !prev || prev.groupId !== r.groupId;
                  return (
                    <AsientoRow
                      key={`${r.groupId}-${r.side}-${idx}`}
                      row={r}
                      isGroupStart={isGroupStart}
                    />
                  );
                })}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={5}>
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.debe)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.haber)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AsientoRow({
  row,
  isGroupStart,
}: {
  row: OKRow;
  isGroupStart: boolean;
}) {
  const isAjuste = row.side === "AJUSTE";
  const bg = isGroupStart
    ? "bg-white"
    : isAjuste
    ? "bg-amber-50/60"
    : "bg-bg-soft/40";
  return (
    <tr
      className={
        "text-sm " +
        (isGroupStart ? "border-t-2 border-border-soft/80 " : "") +
        bg
      }
    >
      <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
        {isGroupStart ? formatDate(row.fecha) : ""}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap font-mono">
        {row.rubro ?? "—"}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        {row.detalle}
        {isAjuste && (
          <span className="ml-1.5 inline-block rounded-full bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 font-bold">
            AJUSTE
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 max-w-[260px] truncate" title={row.cliente}>
        {isGroupStart ? row.cliente : ""}
      </td>
      <td className="px-3 py-1.5 max-w-[320px] truncate" title={row.glosa}>
        {row.glosa}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.debe ? formatMoney(BigInt(row.debe)) : ""}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.haber ? formatMoney(BigInt(row.haber)) : ""}
      </td>
    </tr>
  );
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function firstDayOfMonthIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}
