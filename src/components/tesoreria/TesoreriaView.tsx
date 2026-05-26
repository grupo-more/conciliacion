"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MovementDetail } from "./MovementDetail";
import { RubroMatrix } from "./RubroMatrix";
import type {
  GroupBy,
  MovementsResponse,
  ReportResponse,
  SyncResult,
  SyncStatusResponse,
  TesoreriaMovementDTO,
} from "./types";
import { formatDateTime, formatMoney } from "@/lib/format";

const SYNC_INTERVAL_MS = 30_000;

type Tab = "list" | "report";

export function TesoreriaView() {
  const [tab, setTab] = useState<Tab>("list");
  const [movements, setMovements] = useState<TesoreriaMovementDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<MovementsResponse["facets"]>({
    sucursales: [],
    cajeros: [],
    bancos: [],
    rubrosBanco: [],
    rubrosSucursal: [],
  });
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncBanner, setSyncBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Filtros
  const [sucursalId, setSucursalId] = useState("");
  const [cajero, setCajero] = useState("");
  const [banco, setBanco] = useState("");
  const [rubroBanco, setRubroBanco] = useState("");
  const [rubroSucursal, setRubroSucursal] = useState("");
  const [excepcion, setExcepcion] = useState<"" | "1" | "0">("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [search, setSearch] = useState("");

  // Reporte
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("rubro");

  const [selected, setSelected] = useState<TesoreriaMovementDTO | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function buildParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (sucursalId) p.set("sucursalId", sucursalId);
    if (cajero) p.set("cajero", cajero);
    if (banco) p.set("banco", banco);
    if (rubroBanco) p.set("rubroBanco", rubroBanco);
    if (rubroSucursal) p.set("rubroSucursal", rubroSucursal);
    if (excepcion) p.set("excepcion", excepcion);
    if (since) p.set("since", since);
    if (until) p.set("until", until);
    if (search) p.set("q", search);
    return p;
  }

  async function loadStatus() {
    const res = await fetch("/api/tesoreria/sync-status");
    if (!res.ok) return;
    const data: SyncStatusResponse = await res.json();
    setStatus(data);
  }

  async function loadMovements() {
    setLoading(true);
    const params = buildParams();
    params.set("limit", "5000");
    try {
      const res = await fetch(`/api/tesoreria/movements?${params}`);
      if (!res.ok) {
        setMovements([]);
        setTotal(0);
        return;
      }
      const data: MovementsResponse = await res.json();
      setMovements(data.movements);
      setTotal(data.total);
      setFacets(data.facets);
    } finally {
      setLoading(false);
    }
  }

  async function loadReport() {
    setLoadingReport(true);
    const params = buildParams();
    params.set("groupBy", groupBy);
    try {
      const res = await fetch(`/api/tesoreria/report?${params}`);
      if (!res.ok) {
        setReport(null);
        return;
      }
      const data: ReportResponse = await res.json();
      setReport(data);
    } finally {
      setLoadingReport(false);
    }
  }

  async function doSync(force = false) {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch(
        force ? "/api/tesoreria/sync?force=1" : "/api/tesoreria/sync",
        { method: "POST" }
      );
      const data: SyncResult = await res.json();
      if (data.skipped) return;
      if (!data.ok) {
        setSyncBanner({
          kind: "err",
          msg: data.error || "Error al sincronizar con Tesorería",
        });
        return;
      }
      if (data.insertedRows > 0 || data.updatedRows > 0) {
        setSyncBanner({
          kind: "ok",
          msg: `Sincronizado: ${data.insertedRows} nuevo${data.insertedRows === 1 ? "" : "s"}, ${data.updatedRows} actualizado${data.updatedRows === 1 ? "" : "s"}`,
        });
        loadMovements();
        if (tab === "report") loadReport();
      }
      loadStatus();
    } finally {
      setSyncing(false);
    }
  }

  // Carga inicial + auto-sync
  useEffect(() => {
    loadStatus();
    loadMovements();
    doSync(false);
    intervalRef.current = setInterval(() => doSync(false), SYNC_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "list") loadMovements();
    else loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sucursalId,
    cajero,
    banco,
    rubroBanco,
    rubroSucursal,
    excepcion,
    since,
    until,
    tab,
    groupBy,
  ]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (tab === "list") loadMovements();
      else loadReport();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (syncBanner?.kind === "ok") {
      const t = setTimeout(() => setSyncBanner(null), 4000);
      return () => clearTimeout(t);
    }
  }, [syncBanner]);

  const totalAmount = useMemo(
    () => movements.reduce((acc, m) => acc + Number(m.monto), 0),
    [movements]
  );

  const rubroLabelMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of facets.rubrosBanco) {
      if (r.rubro !== null && r.name) map.set(r.rubro, r.name);
    }
    for (const r of facets.rubrosSucursal) {
      if (r.rubro !== null && r.name) map.set(r.rubro, r.name);
    }
    return map;
  }, [facets.rubrosBanco, facets.rubrosSucursal]);

  function exportReportCSV() {
    if (!report) return;
    const lines: string[] = [];
    const header = ["Fila", ...report.cols.map((c) => csvCell(c.label)), "Total fila", "Mov", "Excepciones"];
    lines.push(header.join(","));
    for (const row of report.matrix) {
      const cells = row.cells.map((c) => c.total.toString());
      lines.push([
        csvCell(row.rowLabel),
        ...cells,
        row.rowTotal.toString(),
        row.rowCount.toString(),
        row.rowExcepciones.toString(),
      ].join(","));
    }
    lines.push([
      "Total columna",
      ...report.cols.map((c) => c.total.toString()),
      report.grand.total.toString(),
      report.grand.count.toString(),
      report.grand.excepciones.toString(),
    ].join(","));

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tesoreria-reporte-${groupBy}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Aplicar filtros desde una celda clickeada en la matriz
  function applyMatrixFilter(rowKey: string, colKey: string) {
    if (groupBy !== "rubro") return;
    if (rowKey === "__null__") setRubroSucursal("none");
    else setRubroSucursal(rowKey);
    if (colKey === "__null__") setRubroBanco("none");
    else setRubroBanco(colKey);
    setTab("list");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-fade-in-down">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tesorería</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Movimientos del feed bancario con informe cruzado de rubros.
          </p>
        </div>
        <button onClick={() => doSync(true)} disabled={syncing} className="btn-primary">
          {syncing ? "Sincronizando…" : "Sincronizar ahora"}
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total movimientos" value={status?.totalMovements?.toLocaleString("es-CL") ?? "—"} />
        <Stat label="En esta vista" value={total.toLocaleString("es-CL")} />
        <Stat label="Suma vista" value={formatMoney(totalAmount)} />
        <Stat
          label="Excepciones"
          value={status?.totalExcepciones?.toLocaleString("es-CL") ?? "—"}
          sub={
            status?.lastOk?.finishedAt
              ? `Sync: ${formatDateTime(status.lastOk.finishedAt)}`
              : undefined
          }
          tone={status?.totalExcepciones && status.totalExcepciones > 0 ? "warn" : undefined}
        />
      </div>

      {syncBanner && (
        <div
          className={
            "rounded-md p-3 text-sm border animate-fade-in-down " +
            (syncBanner.kind === "ok"
              ? "border-success/40 bg-success/10 text-success"
              : "border-danger/40 bg-danger/10 text-danger")
          }
        >
          {syncBanner.msg}
          {syncBanner.kind === "err" && (
            <button onClick={() => setSyncBanner(null)} className="ml-2 underline">
              Cerrar
            </button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border-soft">
        <TabButton active={tab === "list"} onClick={() => setTab("list")}>
          Listado
        </TabButton>
        <TabButton active={tab === "report"} onClick={() => setTab("report")}>
          Informe cruzado
        </TabButton>
        {tab === "report" && (
          <div className="ml-auto pb-2">
            <button onClick={exportReportCSV} disabled={!report} className="btn-ghost text-xs">
              Exportar CSV
            </button>
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="card flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input
            className="input"
            placeholder="Glosa, sucursal, cajero, banco…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Sucursal</label>
          <select className="input" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
            <option value="">Todas</option>
            {facets.sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? `#${s.id}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cajero</label>
          <select className="input" value={cajero} onChange={(e) => setCajero(e.target.value)}>
            <option value="">Todos</option>
            {facets.cajeros.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Banco</label>
          <select className="input" value={banco} onChange={(e) => setBanco(e.target.value)}>
            <option value="">Todos</option>
            {facets.bancos.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.count})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Rubro Sucursal</label>
          <select className="input" value={rubroSucursal} onChange={(e) => setRubroSucursal(e.target.value)}>
            <option value="">Todos</option>
            {facets.rubrosSucursal.map((r) => (
              <option key={r.rubro ?? "none"} value={r.rubro === null ? "none" : String(r.rubro)}>
                {r.rubro === null
                  ? `Sin rubro (${r.count})`
                  : r.name
                  ? `${r.rubro} — ${r.name} (${r.count})`
                  : `${r.rubro} (${r.count})`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Rubro Banco</label>
          <select className="input" value={rubroBanco} onChange={(e) => setRubroBanco(e.target.value)}>
            <option value="">Todos</option>
            {facets.rubrosBanco.map((r) => (
              <option key={r.rubro ?? "none"} value={r.rubro === null ? "none" : String(r.rubro)}>
                {r.rubro === null
                  ? `Sin rubro (${r.count})`
                  : r.name
                  ? `${r.rubro} — ${r.name} (${r.count})`
                  : `${r.rubro} (${r.count})`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Excepción</label>
          <select
            className="input"
            value={excepcion}
            onChange={(e) => setExcepcion(e.target.value as "" | "1" | "0")}
          >
            <option value="">Todos</option>
            <option value="1">Solo excepciones</option>
            <option value="0">Solo normales</option>
          </select>
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
      </div>

      {tab === "list" ? (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
              <tr>
                <th className="px-3 py-2 text-left">Fecha</th>
                <th className="px-3 py-2 text-left">Sucursal</th>
                <th className="px-3 py-2 text-left">Cajero</th>
                <th className="px-3 py-2 text-left">Banco</th>
                <th className="px-3 py-2 text-center">Rubro S/B</th>
                <th className="px-3 py-2 text-left">Glosa</th>
                <th className="px-3 py-2 text-right">Monto</th>
                <th className="px-3 py-2 text-center">Exc</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-text-muted">
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && movements.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-text-muted">
                    Sin movimientos.
                  </td>
                </tr>
              )}
              {!loading &&
                movements.map((m) => {
                  const monto = Number(m.monto);
                  return (
                    <tr
                      key={m.id}
                      onClick={() => setSelected(m)}
                      className={
                        "border-t border-border-soft/40 cursor-pointer table-row-hover " +
                        (m.esExcepcion ? "bg-warn/5 hover:bg-warn/10" : "hover:bg-bg-elevated/40")
                      }
                    >
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(m.fecha)}</td>
                      <td className="px-3 py-2">
                        <div>{m.sucursalName ?? "—"}</div>
                        <div className="text-xs text-text-muted">#{m.sucursalId}</div>
                      </td>
                      <td className="px-3 py-2">
                        {m.cajeroName ? (
                          <>
                            <div className="text-xs">{m.cajeroName}</div>
                            <div className="text-[10px] text-text-muted font-mono">
                              {m.cajeroUsername}
                            </div>
                          </>
                        ) : (
                          <span className="text-xs font-mono">{m.cajeroUsername}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-xs">{m.banco ?? "—"}</div>
                        {m.bancoSucursal && m.bancoDetectado &&
                          m.bancoSucursal.trim().toUpperCase() !==
                            m.bancoDetectado.trim().toUpperCase() && (
                            <div className="text-[10px] text-warn">
                              {m.bancoSucursal} → {m.bancoDetectado}
                            </div>
                          )}
                      </td>
                      <td className="px-3 py-2 text-center text-xs font-mono">
                        <div>
                          {m.rubroSucursal ?? "—"}
                          <span className="text-text-dim mx-1">/</span>
                          {m.rubroBanco ?? "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2 max-w-md truncate" title={m.glosa}>
                        {m.glosa || <span className="text-text-dim">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                        {formatMoney(monto)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {m.esExcepcion ? (
                          <span
                            className="inline-block rounded-full bg-warn/15 text-warn text-[10px] font-semibold px-2 py-0.5"
                            title="Excepción detectada"
                          >
                            EXC
                          </span>
                        ) : (
                          <span className="text-text-dim text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : (
        <RubroMatrix
          report={report}
          loading={loadingReport}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          onCellClick={applyMatrixFilter}
        />
      )}

      {tab === "list" && !loading && total > movements.length && (
        <div className="text-xs text-text-muted">
          Mostrando {movements.length.toLocaleString("es-CL")} de{" "}
          {total.toLocaleString("es-CL")} movimientos. Refina los filtros para acotar.
        </div>
      )}

      {selected && (
        <MovementDetail
          movement={selected}
          rubroBancoLabel={
            selected.rubroBanco !== null ? rubroLabelMap.get(selected.rubroBanco) ?? null : null
          }
          rubroSucursalLabel={
            selected.rubroSucursal !== null
              ? rubroLabelMap.get(selected.rubroSucursal) ?? null
              : null
          }
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={"text-xl font-semibold " + (tone === "warn" ? "text-warn" : "")}>
        {value}
      </div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px " +
        (active
          ? "border-brand text-brand"
          : "border-transparent text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}

function csvCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
