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
import { usePermisos } from "@/lib/use-permisos";
import { TABS_CONSOLIDADOS } from "@/lib/perms-shared";
import { CompareView } from "./CompareView";
import { OKView } from "./OKView";
import { AbonoTransbankView } from "./AbonoTransbankView";
import { CruceTransbankView } from "./CruceTransbankView";
import { DifMenorView } from "./DifMenorView";
import { EgresosTercerosView } from "./EgresosTercerosView";
import { TraspasosInternosView } from "./TraspasosInternosView";
import { AsientosManualesView } from "./AsientosManualesView";

type Period = "day" | "week" | "month";
type Tab =
  | "list"
  | "compare"
  | "compare-egresos"
  | "acreedores-tesoreria"
  | "ok"
  | "abono-transbank"
  | "cruce-transbank"
  | "egresos-terceros"
  | "traspasos-internos"
  | "dif-menor"
  | "asientos-manuales"
  | "proveedores";

export function ConsolidadosView() {
  const { can, canVerTab, loaded } = usePermisos();
  const [tab, setTab] = useState<Tab>("list");
  const [period, setPeriod] = useState<Period>("month");
  const [statusFilter, setStatusFilter] = useState<Set<ConsolidadoStatus>>(new Set());
  const [bancoFilter, setBancoFilter] = useState<string>("");
  const [sucursalFilter, setSucursalFilter] = useState<string>("");
  const [tipoFilter, setTipoFilter] = useState<"" | "INGRESO" | "EGRESO">("");
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
      if (sucursalFilter) p.set("sucursalId", sucursalFilter);
      if (tipoFilter) p.set("tipoOperacion", tipoFilter);
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
  }, [period, bancoFilter, sucursalFilter, tipoFilter]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Debounce del search: se recarga 250ms despues del ultimo tipeo.
  // Asi se siente "search-as-you-type" sin pegarle al API por cada tecla.
  useEffect(() => {
    const h = setTimeout(() => {
      load();
    }, 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // Si el perfil oculta la tab activa, saltar a la primera visible.
  useEffect(() => {
    if (loaded && !canVerTab(tab)) {
      const first = TABS_CONSOLIDADOS.find((t) => canVerTab(t));
      if (first && first !== tab) setTab(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, tab]);

  function toggleStatus(s: ConsolidadoStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const hasFilters =
    statusFilter.size > 0 ||
    bancoFilter !== "" ||
    sucursalFilter !== "" ||
    tipoFilter !== "" ||
    search.trim() !== "";
  function clearFilters() {
    setStatusFilter(new Set());
    setBancoFilter("");
    setSucursalFilter("");
    setTipoFilter("");
    setSearch("");
  }

  // Resumen legible del filtro activo: "Egresos · PATRONATO · Sin match".
  const filterBits: string[] = [];
  if (tipoFilter) filterBits.push(tipoFilter === "EGRESO" ? "Egresos" : "Ingresos");
  if (sucursalFilter) {
    const s = data?.facets.sucursales.find((x) => String(x.id) === sucursalFilter);
    filterBits.push(s?.name ?? `Sucursal #${sucursalFilter}`);
  }
  if (bancoFilter) filterBits.push(bancoFilter);
  if (statusFilter.size > 0) {
    filterBits.push(Array.from(statusFilter).map((s) => STATUS_LABELS[s]).join(" / "));
  }
  if (search.trim()) filterBits.push(`"${search.trim()}"`);

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
            {can("reevaluar") && (
              <button
                onClick={runMatching}
                disabled={running}
                className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                title="Wipea y reconstruye todo el matching (preserva los MANUAL)"
              >
                {running ? "Procesando..." : "Re-evaluar todo"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-border-soft">
        <nav className="flex gap-1 flex-wrap">
          {canVerTab("list") && (
            <TabButton active={tab === "list"} onClick={() => setTab("list")}>
              Lista
            </TabButton>
          )}
          {canVerTab("compare") && (
            <TabButton active={tab === "compare"} onClick={() => setTab("compare")}>
              Comparar Ingresos
            </TabButton>
          )}
          {canVerTab("compare-egresos") && (
            <TabButton
              active={tab === "compare-egresos"}
              onClick={() => setTab("compare-egresos")}
            >
              Comparar Egresos
            </TabButton>
          )}
          {canVerTab("acreedores-tesoreria") && (
            <TabButton
              active={tab === "acreedores-tesoreria"}
              onClick={() => setTab("acreedores-tesoreria")}
            >
              Acreedores tesorería
            </TabButton>
          )}
          {canVerTab("ok") && (
            <TabButton active={tab === "ok"} onClick={() => setTab("ok")}>
              OK
            </TabButton>
          )}
          {canVerTab("abono-transbank") && (
            <TabButton
              active={tab === "abono-transbank"}
              onClick={() => setTab("abono-transbank")}
            >
              Abono Transbank
            </TabButton>
          )}
          {canVerTab("cruce-transbank") && (
            <TabButton
              active={tab === "cruce-transbank"}
              onClick={() => setTab("cruce-transbank")}
            >
              Cruce Transbank
            </TabButton>
          )}
          {canVerTab("egresos-terceros") && (
            <TabButton
              active={tab === "egresos-terceros"}
              onClick={() => setTab("egresos-terceros")}
            >
              Egresos a terceros
            </TabButton>
          )}
          {canVerTab("traspasos-internos") && (
            <TabButton
              active={tab === "traspasos-internos"}
              onClick={() => setTab("traspasos-internos")}
            >
              Traspasos internos
            </TabButton>
          )}
          {canVerTab("dif-menor") && (
            <TabButton
              active={tab === "dif-menor"}
              onClick={() => setTab("dif-menor")}
            >
              Diferencias y comisiones
            </TabButton>
          )}
          {canVerTab("asientos-manuales") && (
            <TabButton
              active={tab === "asientos-manuales"}
              onClick={() => setTab("asientos-manuales")}
            >
              Asientos manuales
            </TabButton>
          )}
          {canVerTab("proveedores") && (
            <TabButton
              active={tab === "proveedores"}
              onClick={() => setTab("proveedores")}
            >
              Proveedores
            </TabButton>
          )}
        </nav>
      </div>

      {/* Contenido por tab (gateado por perfil) */}
      {tab === "compare" && canVerTab("compare") && <CompareView direction="IN" />}
      {tab === "compare-egresos" && canVerTab("compare-egresos") && <CompareView direction="OUT" />}
      {tab === "acreedores-tesoreria" && canVerTab("acreedores-tesoreria") && (
        <CompareView direction="OUT" cola="acreedores" />
      )}
      {tab === "ok" && canVerTab("ok") && <OKView />}
      {tab === "abono-transbank" && canVerTab("abono-transbank") && <AbonoTransbankView />}
      {tab === "cruce-transbank" && canVerTab("cruce-transbank") && <CruceTransbankView />}
      {tab === "egresos-terceros" && canVerTab("egresos-terceros") && <EgresosTercerosView />}
      {tab === "traspasos-internos" && canVerTab("traspasos-internos") && <TraspasosInternosView />}
      {tab === "dif-menor" && canVerTab("dif-menor") && <DifMenorView />}
      {tab === "asientos-manuales" && canVerTab("asientos-manuales") && <AsientosManualesView />}
      {tab === "proveedores" && canVerTab("proveedores") && <AsientosManualesView queue="proveedores" />}

      {tab === "list" && canVerTab("list") && (
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
              {runResult.anulados > 0 ? ` · ${runResult.anulados} anulados` : ""}
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
              value={tipoFilter}
              onChange={(e) => setTipoFilter(e.target.value as "" | "INGRESO" | "EGRESO")}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
            >
              <option value="">Ingresos y egresos</option>
              <option value="INGRESO">Solo ingresos</option>
              <option value="EGRESO">Solo egresos</option>
            </select>
            <select
              value={sucursalFilter}
              onChange={(e) => setSucursalFilter(e.target.value)}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
            >
              <option value="">Todas las sucursales</option>
              {data?.facets.sucursales.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name ?? `#${s.id}`}
                </option>
              ))}
            </select>
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
              placeholder="Buscar cliente / glosa / RUT / monto..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white flex-1 min-w-[200px]"
            />
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="rounded-md border border-border-soft px-3 py-1.5 text-sm text-text-muted hover:bg-bg-soft whitespace-nowrap"
                title="Quitar status, banco y búsqueda"
              >
                × Limpiar filtros
              </button>
            )}
          </div>

          {/* Resumen del filtro activo */}
          {!loading && data && data.rows.length > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="text-text-muted">Viendo:</span>
              <span className="font-medium">
                {filterBits.length > 0 ? filterBits.join(" · ") : "Todos los movimientos"}
              </span>
              <span className="text-text-dim">·</span>
              <span className="text-text-muted">
                {data.filteredTotal.toLocaleString("es-CL")} mov
                {data.filteredTotal === 1 ? "" : "s"}
              </span>
              <span className="text-text-dim">·</span>
              <span className="text-text-muted">
                suma{" "}
                <span
                  className={
                    "font-mono font-medium " +
                    (BigInt(data.filteredSum) < 0n ? "text-rose-600" : "text-emerald-700")
                  }
                >
                  {formatMoney(BigInt(data.filteredSum))}
                </span>
              </span>
            </div>
          )}

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
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-bg-soft text-xs uppercase tracking-wider text-text-muted shadow-[0_1px_0_0_rgba(0,0,0,0.06)]">
                    <tr>
                      <th className="px-3 py-2 text-left">Fecha</th>
                      <th className="px-3 py-2 text-left">Sucursal</th>
                      <th className="px-3 py-2 text-left">Banco</th>
                      <th className="px-3 py-2 text-right">Monto</th>
                      <th className="px-3 py-2 text-center">Tipo</th>
                      <th className="px-3 py-2 text-left">Cliente</th>
                      <th className="px-3 py-2 text-left">Glosa</th>
                      <th className="px-3 py-2 text-left">Estado</th>
                      <th className="px-3 py-2 text-center">Score</th>
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

          {!loading && data && data.rows.length > 0 && (
            <div className="text-xs text-text-muted">
              Mostrando {data.rows.length.toLocaleString("es-CL")} de{" "}
              {data.filteredTotal.toLocaleString("es-CL")} movimiento
              {data.filteredTotal === 1 ? "" : "s"}.
              {data.rows.length >= 500 && (
                <span className="text-amber-700">
                  {" "}
                  Límite de 500 alcanzado — refiná los filtros para ver el resto.
                </span>
              )}
            </div>
          )}
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
  const montoBig = BigInt(row.monto);
  const esEgreso = row.tipoOperacion === "EGRESO" || montoBig < 0n;
  const absMonto = montoBig < 0n ? -montoBig : montoBig;
  return (
    <tr
      onClick={onClick}
      className="border-t border-border-soft/60 odd:bg-white even:bg-bg-soft/40 hover:bg-bg-soft/70 cursor-pointer transition-colors"
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
      <td
        className={
          "px-3 py-2 text-right font-mono whitespace-nowrap font-medium " +
          (esEgreso ? "text-rose-600" : "text-emerald-700")
        }
      >
        {esEgreso ? `-${formatMoney(absMonto)}` : formatMoney(montoBig)}
      </td>
      <td className="px-3 py-2 text-center whitespace-nowrap">
        <span
          className={
            "inline-block rounded-full text-[10px] font-bold px-2 py-0.5 " +
            (esEgreso
              ? "bg-rose-500/15 text-rose-600"
              : "bg-emerald-500/15 text-emerald-600")
          }
        >
          {esEgreso ? "EGRESO" : "INGRESO"}
        </span>
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
        {/* Anulado en origen pero con status conciliado (MANUAL preservado):
            alerta de que el lado banco quedó sin contraparte válida. */}
        {row.estadoActual === "ANU" && status !== "ANULADO" && (
          <span
            className="ml-1 inline-block rounded-full bg-purple-100 text-purple-800 border border-purple-200 text-[10px] px-1.5 py-0.5 font-bold"
            title="El movimiento de tesorería está anulado en origen"
          >
            ⚠ ANULADO
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        <ScoreBadge score={row.consolidado?.score ?? null} />
      </td>
      <td className="px-3 py-2 text-center">
        {canUndo ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUndo();
            }}
            className="text-[11px] text-rose-700 hover:underline whitespace-nowrap"
            title={
              status === "SUGGESTED" || status === "REVIEW"
                ? "Descartar sugerencia (pide confirmación)"
                : "Deshacer match (pide confirmación)"
            }
          >
            {status === "SUGGESTED" || status === "REVIEW"
              ? "Descartar"
              : "Deshacer"}
          </button>
        ) : (
          <span className="text-text-dim">—</span>
        )}
      </td>
    </tr>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-text-dim text-xs">—</span>;
  const tone =
    score >= 80
      ? "bg-emerald-100 text-emerald-800"
      : score >= 50
      ? "bg-amber-100 text-amber-800"
      : "bg-rose-100 text-rose-800";
  return (
    <span
      className={"inline-block rounded-full text-[11px] font-bold px-2 py-0.5 font-mono " + tone}
      title="Score de confianza del match (0–100)"
    >
      {score}
    </span>
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
  // SUGGESTED/REVIEW son propuestas sin vincular: "deshacer" aquí es descartar
  // la sugerencia (pasa a NO_MATCH), no romper un match existente.
  const isProposal = linkCount === 0;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-panel max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight mb-2">
          {isProposal ? "Descartar esta sugerencia?" : "Deshacer este match?"}
        </h2>
        <p className="text-sm text-text-muted mb-4">
          {isProposal ? (
            <>
              Es una propuesta <strong>sin vincular</strong>. Pasará a{" "}
              <strong>NO_MATCH</strong> (descartada) y dejará de sugerirse. Podés
              revertirlo corriendo "Re-evaluar todo". Confirmá los datos antes:
            </>
          ) : (
            <>
              La conciliación volverá a estado <strong>NO_MATCH</strong> y se
              perderán los {linkCount} vínculo{linkCount === 1 ? "" : "s"} con las
              cartolas. Esta acción se puede rehacer matcheando de nuevo, pero
              confirmá los datos antes:
            </>
          )}
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
            {loading
              ? isProposal
                ? "Descartando…"
                : "Deshaciendo…"
              : isProposal
              ? "Sí, descartar"
              : "Sí, deshacer"}
          </button>
        </div>
      </div>
    </div>
  );
}
