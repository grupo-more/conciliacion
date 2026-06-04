"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";

type MatchVia = "rut" | "rut_in_name" | "rut_in_desc" | "alias";

interface EgresoInternoRow {
  id: string;
  fecha: string;
  accountId: string;
  cuentaLabel: string;
  bankName: string;
  accountNumber: string;
  monto: string;
  counterpartyRut: string | null;
  counterpartyName: string | null;
  description: string | null;
  entidadId: string;
  entidadNombre: string;
  entidadRut: string;
  entidadRubro: number | null;
  via: MatchVia;
  evidence: string;
}

interface EgresosInternosResponse {
  from: string;
  to: string;
  rows: EgresoInternoRow[];
  totals: { count: number; monto: string };
  facets: {
    accounts: { id: string; label: string }[];
    entidades: { id: string; nombre: string; count: number }[];
  };
}

const VIA_LABEL: Record<MatchVia, string> = {
  rut: "RUT",
  rut_in_name: "RUT en nombre",
  rut_in_desc: "RUT en glosa",
  alias: "Alias",
};

const VIA_COLOR: Record<MatchVia, string> = {
  rut: "bg-emerald-100 text-emerald-800 border-emerald-300",
  rut_in_name: "bg-sky-100 text-sky-800 border-sky-300",
  rut_in_desc: "bg-violet-100 text-violet-800 border-violet-300",
  alias: "bg-amber-100 text-amber-800 border-amber-300",
};

/**
 * Tab "Egresos internos" de Consolidados: lista los BankMovement con
 * direction=OUT que el detector identifica como egresos a entidades propias.
 * No hay match contra Tesoreria — es una vista derivada del BankMovement +
 * la tabla EntidadInterna (configurable desde Configuracion).
 */
export function EgresosInternosView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [entidadId, setEntidadId] = useState<string>("");
  const [via, setVia] = useState<MatchVia | "">("");

  const [data, setData] = useState<EgresosInternosResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (accountId) p.set("accountId", accountId);
      if (entidadId) p.set("entidadId", entidadId);
      if (via) p.set("via", via);
      const res = await fetch(`/api/consolidados/egresos-internos?${p}`);
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
  }, [from, to, accountId, entidadId, via]);

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
        "Entidad",
        "RUT entidad",
        "Rubro",
        "Vía match",
        "RUT contraparte",
        "Nombre contraparte",
        "Glosa",
      ],
    ];
    for (const r of data.rows) {
      aoa.push([
        formatDate(r.fecha),
        r.bankName,
        r.accountNumber,
        Number(r.monto),
        r.entidadNombre,
        r.entidadRut,
        r.entidadRubro ?? "",
        VIA_LABEL[r.via],
        r.counterpartyRut ?? "",
        r.counterpartyName ?? "",
        r.description ?? "",
      ]);
    }
    aoa.push([
      "",
      "",
      "TOTAL",
      Number(totalMonto),
      "",
      "",
      "",
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
      { wch: 22 },
      { wch: 14 },
      { wch: 8 },
      { wch: 14 },
      { wch: 14 },
      { wch: 28 },
      { wch: 40 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Egresos internos");
    XLSX.writeFile(wb, `egresos_internos_${from}_${to}.xlsx`);
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
          value={entidadId}
          onChange={(e) => setEntidadId(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las entidades</option>
          {data?.facets.entidades.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nombre} ({e.count})
            </option>
          ))}
        </select>
        <select
          value={via}
          onChange={(e) => setVia(e.target.value as MatchVia | "")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las vías</option>
          <option value="rut">{VIA_LABEL.rut}</option>
          <option value="rut_in_name">{VIA_LABEL.rut_in_name}</option>
          <option value="rut_in_desc">{VIA_LABEL.rut_in_desc}</option>
          <option value="alias">{VIA_LABEL.alias}</option>
        </select>
        {hasRows && (
          <span className="text-xs text-text-muted">
            {data!.totals.count} egreso{data!.totals.count === 1 ? "" : "s"} ·{" "}
            <span className="font-mono">{formatMoney(totalMonto)}</span>
          </span>
        )}
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
            No hay egresos internos detectados en este filtro.
            <div className="text-xs mt-2">
              Si esperabas resultados, revisá que haya entidades cargadas en{" "}
              <strong>Configuración → Entidades internas</strong>.
            </div>
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
                  <th className="px-3 py-2 text-left">Entidad</th>
                  <th className="px-3 py-2 text-left">Vía</th>
                  <th className="px-3 py-2 text-left">Contraparte cartola</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
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
                      <div className="text-text">{r.bankName}</div>
                      <div className="text-xs text-text-muted font-mono">
                        {r.accountNumber}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {formatMoney(BigInt(r.monto))}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.entidadNombre}</div>
                      <div className="text-xs text-text-muted font-mono">
                        {r.entidadRut}
                        {r.entidadRubro != null && (
                          <span className="ml-1 text-text-dim">
                            · r{r.entidadRubro}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${VIA_COLOR[r.via]}`}
                      >
                        {VIA_LABEL[r.via]}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 max-w-[220px] truncate"
                      title={`RUT: ${r.counterpartyRut ?? "—"}\nNombre: ${r.counterpartyName ?? "—"}`}
                    >
                      {r.counterpartyName || r.counterpartyRut || (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 max-w-[280px] truncate"
                      title={r.description ?? ""}
                    >
                      {r.description ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={2}>
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totalMonto)}
                  </td>
                  <td colSpan={4} />
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
