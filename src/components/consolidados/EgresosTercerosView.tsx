"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";
import { ConciliacionBadge } from "./ConciliacionBadge";

type Quality = "con_rut" | "solo_nombre" | "sin_info";

interface EgresoTerceroRow {
  id: string;
  fecha: string;
  accountId: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  counterpartyRut: string | null;
  counterpartyName: string | null;
  description: string | null;
  quality: Quality;
  conciliacion: {
    status: string;
    matchType: string | null;
    tesoreriaExternalId: string;
  } | null;
}

interface EgresosTercerosResponse {
  from: string;
  to: string;
  rows: EgresoTerceroRow[];
  totals: { count: number; monto: string };
  qualityCount: Record<Quality, number>;
  facets: {
    accounts: { id: string; label: string }[];
  };
}

const QUALITY_LABEL: Record<Quality, string> = {
  con_rut: "Con RUT",
  solo_nombre: "Solo nombre",
  sin_info: "Sin info",
};

const QUALITY_COLOR: Record<Quality, string> = {
  con_rut: "bg-emerald-100 text-emerald-800 border-emerald-300",
  solo_nombre: "bg-amber-100 text-amber-800 border-amber-300",
  sin_info: "bg-rose-100 text-rose-800 border-rose-300",
};

/**
 * Tab "Egresos a terceros" de Consolidados. Complemento de "Egresos internos":
 * lista todos los OUT del rango que NO matchearon ninguna entidad interna.
 * La union de ambas vistas == todos los OUT.
 */
export function EgresosTercerosView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [quality, setQuality] = useState<Quality | "">("");
  const [search, setSearch] = useState<string>("");
  // Debounce simple del search para no pegarle al API por tecla.
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");

  const [data, setData] = useState<EgresosTercerosResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(h);
  }, [search]);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (accountId) p.set("accountId", accountId);
      if (quality) p.set("quality", quality);
      if (debouncedSearch) p.set("q", debouncedSearch);
      const res = await fetch(`/api/consolidados/egresos-terceros?${p}`);
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
  }, [from, to, accountId, quality, debouncedSearch]);

  const totalMonto = useMemo(() => {
    if (!data) return 0n;
    return BigInt(data.totals.monto);
  }, [data]);

  function exportXlsx() {
    if (!data || data.rows.length === 0) return;
    const aoa: (string | number)[][] = [
      [
        "Fecha",
        "Banco origen",
        "Cuenta",
        "Monto",
        "RUT contraparte",
        "Nombre contraparte",
        "Calidad",
        "Glosa",
      ],
    ];
    for (const r of data.rows) {
      aoa.push([
        formatDate(r.fecha),
        r.holderName ? `${r.bankName} ${r.holderName}` : r.bankName,
        r.accountNumber,
        -Number(r.monto),
        r.counterpartyRut ?? "",
        r.counterpartyName ?? "",
        QUALITY_LABEL[r.quality],
        r.description ?? "",
      ]);
    }
    aoa.push([
      "",
      "",
      "TOTAL",
      -Number(totalMonto),
      "",
      "",
      "",
      "",
    ]);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [
      { wch: 12 },
      { wch: 14 },
      { wch: 18 },
      { wch: 14 },
      { wch: 14 },
      { wch: 28 },
      { wch: 12 },
      { wch: 40 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Egresos terceros");
    XLSX.writeFile(wb, `egresos_terceros_${from}_${to}.xlsx`);
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
          value={quality}
          onChange={(e) => setQuality(e.target.value as Quality | "")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">
            Todas las calidades
            {data ? ` (${data.totals.count})` : ""}
          </option>
          <option value="con_rut">
            {QUALITY_LABEL.con_rut}
            {data ? ` (${data.qualityCount.con_rut})` : ""}
          </option>
          <option value="solo_nombre">
            {QUALITY_LABEL.solo_nombre}
            {data ? ` (${data.qualityCount.solo_nombre})` : ""}
          </option>
          <option value="sin_info">
            {QUALITY_LABEL.sin_info}
            {data ? ` (${data.qualityCount.sin_info})` : ""}
          </option>
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar nombre / RUT / glosa..."
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white flex-1 min-w-[200px]"
        />
        {hasRows && (
          <span className="text-xs text-text-muted">
            {data!.totals.count} egreso{data!.totals.count === 1 ? "" : "s"} ·{" "}
            <span className="font-mono text-rose-600">
              -{formatMoney(totalMonto)}
            </span>
          </span>
        )}
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
            No hay egresos a terceros en este filtro.
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Cuenta origen</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-left">RUT</th>
                  <th className="px-3 py-2 text-left">Nombre</th>
                  <th className="px-3 py-2 text-left">Calidad</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-left">Conciliación</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-border-soft/60 hover:bg-bg-soft/40"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatDate(r.fecha)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-text">
                        {r.bankName}
                        {r.holderName ? ` ${r.holderName}` : ""}
                      </div>
                      <div className="text-xs text-text-muted font-mono">
                        {r.accountNumber}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-rose-600">
                      -{formatMoney(BigInt(r.monto))}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                      {r.counterpartyRut || (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 max-w-[260px] truncate"
                      title={r.counterpartyName ?? ""}
                    >
                      {r.counterpartyName || (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${QUALITY_COLOR[r.quality]}`}
                      >
                        {QUALITY_LABEL[r.quality]}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 max-w-[320px] truncate"
                      title={r.description ?? ""}
                    >
                      {r.description ?? ""}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <ConciliacionBadge conciliacion={r.conciliacion} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={2}>
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-rose-600">
                    -{formatMoney(totalMonto)}
                  </td>
                  <td colSpan={5} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
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
