"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import {
  type ConsolidadoRow,
  type ConsolidadoStatus,
  type OverviewResponse,
  type RunResult,
  STATUS_COLORS,
  STATUS_LABELS,
  STATUS_ORDER,
} from "./types";
import { ConsolidadoDetail } from "./ConsolidadoDetail";
import { CompareView } from "./CompareView";
import { OKView } from "./OKView";
import { AbonoTransbankView } from "./AbonoTransbankView";

type Period = "day" | "week" | "month";
type Tab = "list" | "compare" | "ok" | "abono-transbank";

export function ConsolidadosView() {
  const [tab, setTab] = useState<Tab>("list");
  const [period, setPeriod] = useState<Period>("month");
  const [statusFilter, setStatusFilter] = useState<Set<ConsolidadoStatus>>(new Set());
  const [bancoFilter, setBancoFilter] = useState<string>("");
  const [search, setSearch] = useState("");

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<ConsolidadoRow | null>(null);
  const [undoing, setUndoing] = useState(false);

  async function confirmUndo() {
    if (!undoTarget) return;
    setUndoing(true);
    try {
      const res = await fetch(`/api/consolidados/${undoTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || "Error al deshacer");
        return;
      }
      setUndoTarget(null);
      await load();
    } finally {
      setUndoing(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ period });
      if (statusFilter.size > 0) {
        p.set("status", Array.from(statusFilter).join(","));
      }
      if (bancoFilter) p.set("banco", bancoFilter);
      if (search.trim()) p.set("q", search.trim());
      const res = await fetch(`/api/consolidados/overview?${p}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function runMatching() {
    if (running) return; // doble seguro client-side
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/consolidados/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const result: RunResult = await res.json();
        setRunResult(result);
        await load();
      }
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, bancoFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function toggleStatus(s: ConsolidadoStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-brand">Consolidados</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Matching entre movimientos de Tesorería y cartolas bancarias
          </p>
        </div>
        {tab === "list" && (
          <div className="flex items-center gap-2">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
            >
              <option value="day">Hoy</option>
              <option value="week">Última semana</option>
              <option value="month">Último mes</option>
            </select>
            <button
              onClick={runMatching}
              disabled={running}
              className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
              title="Wipea y reconstruye todo el matching (preserva los MANUAL)"
            >
              {running ? "Procesando..." : "Re-evaluar todo"}
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-border-soft">
        <nav className="flex gap-1">
          <TabButton active={tab === "list"} onClick={() => setTab("list")}>
            Lista
          </TabButton>
          <TabButton active={tab === "compare"} onClick={() => setTab("compare")}>
            Comparar
          </TabButton>
          <TabButton active={tab === "ok"} onClick={() => setTab("ok")}>
            OK
          </TabButton>
          <TabButton
            active={tab === "abono-transbank"}
            onClick={() => setTab("abono-transbank")}
          >
            Abono Transbank
          </TabButton>
        </nav>
      </div>

      {/* Contenido por tab */}
      {tab === "compare" && <CompareView />}
      {tab === "ok" && <OKView />}
      {tab === "abono-transbank" && <AbonoTransbankView />}

      {tab === "list" && (
        <>
          {/* Banner de resultado del run */}
          {runResult && (
            <div className="rounded-md border border-brand/20 bg-brand/5 px-4 py-3 text-sm">
              <strong>
                Procesados {runResult.processed} movimientos en {runResult.ms} ms.
              </strong>{" "}
              {runResult.autoMatched} conciliados auto · {runResult.suggested} sugeridos ·{" "}
              {runResult.review} a revisar · {runResult.noMatch} sin match ·{" "}
              {runResult.outOfScope} fuera de scope
              {runResult.errors > 0 ? ` · ${runResult.errors} errores` : ""}
            </div>
          )}

          {/* Chips de status */}
          <div className="flex flex-wrap gap-2">
            {STATUS_ORDER.map((s) => {
              const count = data?.counts[s] ?? 0;
              const active = statusFilter.has(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-all ${
                    active
                      ? `${STATUS_COLORS[s]} ring-2 ring-offset-1 ring-brand/40`
                      : "border-border-soft bg-white text-text-muted hover:bg-bg-soft"
                  }`}
                >
                  {STATUS_LABELS[s]} <span className="font-bold ml-1">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Filtros extra */}
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={bancoFilter}
              onChange={(e) => setBancoFilter(e.target.value)}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
            >
              <option value="">Todos los bancos</option>
              {data?.facets.bancos.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Buscar cliente / glosa / RUT..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white flex-1 min-w-[200px]"
            />
            <button
              onClick={load}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm hover:bg-bg-soft"
            >
              Buscar
            </button>
          </div>

          {/* Tabla */}
          <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
            {loading && (
              <div className="text-center py-8 text-sm text-text-muted">Cargando...</div>
            )}
            {!loading && data && data.rows.length === 0 && (
              <div className="text-center py-8 text-sm text-text-muted">
                No hay movimientos en este filtro.
              </div>
            )}
            {!loading && data && data.rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Fecha</th>
                      <th className="px-3 py-2 text-left">Sucursal</th>
                      <th className="px-3 py-2 text-left">Banco</th>
                      <th className="px-3 py-2 text-right">Monto</th>
                      <th className="px-3 py-2 text-left">Cliente</th>
                      <th className="px-3 py-2 text-left">Glosa</th>
                      <th className="px-3 py-2 text-left">Estado</th>
                      <th className="px-3 py-2 text-right">Score</th>
                      <th className="px-3 py-2 text-center w-20">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <Row
                        key={row.id}
                        row={row}
                        onClick={() => setSelectedId(row.id)}
                        onUndo={() => setUndoTarget(row)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {selectedId && (
        <ConsolidadoDetail
          tesoreriaId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => load()}
        />
      )}

      {undoTarget && (
        <UndoConfirmModal
          row={undoTarget}
          loading={undoing}
          onCancel={() => setUndoTarget(null)}
          onConfirm={confirmUndo}
        />
      )}
    </div>
  );
}

/* ============================== Subcomponentes ============================== */

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
        "relative px-4 py-2.5 text-sm font-semibold transition-colors duration-200 " +
        (active ? "text-brand" : "text-text-muted hover:text-brand")
      }
    >
      {children}
      {active && (
        <span
          className="absolute inset-x-2 -bottom-px h-0.5 bg-brand rounded-full"
          aria-hidden
        />
      )}
    </button>
  );
}

function Row({
  row,
  onClick,
  onUndo,
}: {
  row: ConsolidadoRow;
  onClick: () => void;
  onUndo: () => void;
}) {
  const status: ConsolidadoStatus = row.consolidado
    ? (row.consolidado.status as ConsolidadoStatus)
    : "UNPROCESSED";
  const canUndo =
    status === "AUTO_MATCHED" ||
    status === "MANUAL" ||
    status === "SUGGESTED" ||
    status === "REVIEW";
  return (
    <tr
      onClick={onClick}
      className="border-t border-border-soft/60 hover:bg-bg-soft/60 cursor-pointer transition-colors"
    >
      <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.fecha)}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {row.sucursalName ?? `#${row.sucursalId}`}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {row.banco ?? "—"}
        {row.esExcepcion && (
          <span className="ml-1 inline-block rounded-full bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 font-bold">
            EXC
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
        {formatMoney(BigInt(row.monto))}
      </td>
      <td className="px-3 py-2 max-w-[200px] truncate" title={row.clienteName ?? ""}>
        {row.clienteName ?? "—"}
      </td>
      <td className="px-3 py-2 max-w-[260px] truncate" title={row.glosa}>
        {row.glosa}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs">
        {row.consolidado?.score ?? "—"}
      </td>
      <td className="px-3 py-2 text-center">
        {canUndo ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUndo();
            }}
            className="text-[11px] text-rose-700 hover:underline whitespace-nowrap"
            title="Deshacer match (pide confirmación)"
          >
            Deshacer
          </button>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>
    </tr>
  );
}

/* ============================ Undo confirm modal ============================ */

function UndoConfirmModal({
  row,
  loading,
  onCancel,
  onConfirm,
}: {
  row: ConsolidadoRow;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const status = (row.consolidado?.status ?? "UNPROCESSED") as ConsolidadoStatus;
  const isAuto = status === "AUTO_MATCHED";
  const linkCount = row.consolidado?.links.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-panel max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight mb-2">
          Deshacer este match?
        </h2>
        <p className="text-sm text-text-muted mb-4">
          La conciliación volverá a estado <strong>NO_MATCH</strong> y se
          perderán los {linkCount} vínculo{linkCount === 1 ? "" : "s"} con las
          cartolas. Esta acción se puede rehacer matcheando de nuevo, pero
          confirmá los datos antes:
        </p>

        <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm space-y-1 mb-3">
          <div>
            <span className="text-text-muted">Fecha:</span>{" "}
            <strong>{formatDate(row.fecha)}</strong>
          </div>
          <div>
            <span className="text-text-muted">Sucursal:</span>{" "}
            {row.sucursalName ?? `#${row.sucursalId}`}
          </div>
          <div>
            <span className="text-text-muted">Banco:</span> {row.banco ?? "—"}
          </div>
          <div>
            <span className="text-text-muted">Monto:</span>{" "}
            <strong className="font-mono">
              {formatMoney(BigInt(row.monto))}
            </strong>
          </div>
          <div>
            <span className="text-text-muted">Cliente:</span>{" "}
            {row.clienteName ?? "—"}
          </div>
          <div>
            <span className="text-text-muted">Estado actual:</span>{" "}
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[status]}`}
            >
              {STATUS_LABELS[status]}
            </span>
          </div>
        </div>

        {isAuto && (
          <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 p-2.5 text-xs mb-3">
            <strong>⚠ Atención:</strong> este es un match automático. Si después
            corrés "Re-evaluar todo" el motor puede volver a matchearlo igual.
            Para que el rechazo persista, vinculalo manualmente a otra cartola o
            dejá una nota en el detalle.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="btn-ghost"
            autoFocus
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="btn-primary bg-rose-600 hover:bg-rose-700"
          >
            {loading ? "Deshaciendo…" : "Sí, deshacer"}
          </button>
        </div>
      </div>
    </div>
  );
}
