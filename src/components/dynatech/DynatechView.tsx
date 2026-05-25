"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MovementDetail } from "./MovementDetail";
import type {
  DynatechMovementDTO,
  MovementsResponse,
  SyncResult,
  SyncStatusResponse,
} from "./types";
import { formatDateTime, formatMoney } from "@/lib/format";

const SYNC_INTERVAL_MS = 30_000;

export function DynatechView() {
  const [movements, setMovements] = useState<DynatechMovementDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<MovementsResponse["facets"]>({
    branches: [],
    cashiers: [],
    rubros: [],
  });
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncBanner, setSyncBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  // Filtros manuales (todos opcionales, se aplican en cliente al pulsar)
  const [branchId, setBranchId] = useState("");
  const [cashier, setCashier] = useState("");
  const [docCode, setDocCode] = useState("");
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [search, setSearch] = useState("");
  const [rubro, setRubro] = useState("");

  const [selected, setSelected] = useState<DynatechMovementDTO | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadStatus() {
    const res = await fetch("/api/dynatech/sync-status");
    if (!res.ok) return;
    const data: SyncStatusResponse = await res.json();
    setStatus(data);
  }

  async function loadMovements() {
    setLoading(true);
    const params = new URLSearchParams({ limit: "5000" });
    if (branchId) params.set("branchId", branchId);
    if (cashier) params.set("cashier", cashier);
    if (docCode) params.set("docCode", docCode);
    if (direction) params.set("direction", direction);
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (search) params.set("q", search);
    if (rubro) params.set("rubro", rubro);

    try {
      const res = await fetch(`/api/dynatech/movements?${params}`);
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

  async function doSync(force = false) {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch(
        force ? "/api/dynatech/sync?force=1" : "/api/dynatech/sync",
        { method: "POST" }
      );
      const data: SyncResult = await res.json();

      if (data.skipped) return;
      if (!data.ok) {
        setSyncBanner({
          kind: "err",
          msg: data.error || "Error al sincronizar con Dynatech",
        });
        return;
      }
      if (data.insertedRows > 0) {
        setSyncBanner({
          kind: "ok",
          msg: `Sincronizado: ${data.insertedRows} movimiento${data.insertedRows === 1 ? "" : "s"} nuevo${data.insertedRows === 1 ? "" : "s"}`,
        });
        loadMovements();
      }
      loadStatus();
    } finally {
      setSyncing(false);
    }
  }

  // Carga inicial + auto-sync periódico
  useEffect(() => {
    loadStatus();
    loadMovements();
    doSync(false);

    intervalRef.current = setInterval(() => {
      doSync(false);
    }, SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadMovements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, cashier, docCode, direction, since, until, rubro]);

  useEffect(() => {
    const t = setTimeout(() => loadMovements(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (syncBanner?.kind === "ok") {
      const t = setTimeout(() => setSyncBanner(null), 4000);
      return () => clearTimeout(t);
    }
  }, [syncBanner]);

  const totalAmount = useMemo(() => {
    return movements.reduce((acc, m) => acc + Number(m.totalAmount), 0);
  }, [movements]);

  const rubroLabelMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of facets.rubros) {
      if (r.rubro !== null && r.name) map.set(r.rubro, r.name);
    }
    return map;
  }, [facets.rubros]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-fade-in-down">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dynatech</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Vista cruda de los movimientos de la API de Dynatech.
          </p>
        </div>
        <button
          onClick={() => doSync(true)}
          disabled={syncing}
          className="btn-primary"
        >
          {syncing ? "Sincronizando…" : "Sincronizar ahora"}
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="Total movimientos"
          value={status?.totalMovements?.toLocaleString("es-CL") ?? "—"}
        />
        <Stat label="En esta vista" value={total.toLocaleString("es-CL")} />
        <Stat label="Suma vista" value={formatMoney(totalAmount)} />
        <Stat
          label="Último sync"
          value={
            status?.lastOk?.finishedAt
              ? formatDateTime(status.lastOk.finishedAt)
              : "—"
          }
          sub={
            status?.lastAny?.status === "ERROR"
              ? "⚠ último intento falló"
              : undefined
          }
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
            <button
              onClick={() => setSyncBanner(null)}
              className="ml-2 underline"
            >
              Cerrar
            </button>
          )}
        </div>
      )}

      {/* Filtros manuales */}
      <div className="card flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input
            className="input"
            placeholder="Observación, sucursal, cajero…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Sucursal</label>
          <select
            className="input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            <option value="">Todas</option>
            {facets.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? `#${b.id}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cajero</label>
          <select
            className="input"
            value={cashier}
            onChange={(e) => setCashier(e.target.value)}
          >
            <option value="">Todos</option>
            {facets.cashiers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Rubro</label>
          <select
            className="input"
            value={rubro}
            onChange={(e) => setRubro(e.target.value)}
          >
            <option value="">Todos</option>
            {facets.rubros.map((r) => (
              <option
                key={r.rubro ?? "none"}
                value={r.rubro === null ? "none" : String(r.rubro)}
              >
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
          <label className="label">Tipo</label>
          <select
            className="input"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "" | "IN" | "OUT")}
          >
            <option value="">Todos</option>
            <option value="IN">Ingresos (Venta de…)</option>
            <option value="OUT">Egresos (Compra de…)</option>
          </select>
        </div>
        <div>
          <label className="label">Cód. doc.</label>
          <select
            className="input"
            value={docCode}
            onChange={(e) => setDocCode(e.target.value)}
          >
            <option value="">Todos</option>
            <option value="34">34 — Factura No Afecta</option>
            <option value="41">41 — Boleta Exenta</option>
          </select>
        </div>
        <div>
          <label className="label">Desde</label>
          <input
            type="date"
            className="input"
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input
            type="date"
            className="input"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
      </div>

      {/* Tabla */}
      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Sucursal</th>
              <th className="px-3 py-2 text-left">Cajero</th>
              <th className="px-3 py-2 text-left">Cliente</th>
              <th className="px-3 py-2 text-left">Doc / Folio</th>
              <th className="px-3 py-2 text-left">Operación</th>
              <th className="px-3 py-2 text-right">Cant.</th>
              <th className="px-3 py-2 text-right">Tasa</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-left">Observación</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && movements.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  Sin movimientos.
                </td>
              </tr>
            )}
            {!loading &&
              movements.map((m) => {
                const firstItem = m.items[0];
                const itemCount = m.items.length;
                const totalAmt = Number(m.totalAmount);
                const isVenta = firstItem?.nombre.toLowerCase().startsWith("venta");
                const isCompra = firstItem?.nombre.toLowerCase().startsWith("compra");
                const totalCls = isVenta
                  ? "text-success"
                  : isCompra
                  ? "text-danger"
                  : "";
                return (
                  <tr
                    key={m.id}
                    onClick={() => setSelected(m)}
                    className="border-t border-border-soft/40 hover:bg-bg-elevated/40 cursor-pointer table-row-hover"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatDateTime(m.occurredAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div>{m.branchExternalName ?? "—"}</div>
                      <div className="text-xs text-text-muted">
                        #{m.branchExternalId}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {m.cashierName ? (
                        <>
                          <div className="text-xs">{m.cashierName}</div>
                          <div className="text-[10px] text-text-muted font-mono">
                            {m.cashierUsername}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs font-mono">{m.cashierUsername}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {m.customerRut ? (
                        <>
                          <div className="text-xs truncate max-w-[200px]" title={m.customerName ?? undefined}>
                            {m.customerName ?? "—"}
                          </div>
                          <div className="text-[10px] text-text-muted font-mono">
                            {m.customerRut}
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-text-dim">Genérico</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs">{m.documentCode}</div>
                      <div className="text-xs text-text-muted font-mono">
                        {m.documentFolio === "0" ? "—" : m.documentFolio}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {firstItem ? (
                        <>
                          <div className="truncate max-w-[180px]">
                            {firstItem.nombre}
                          </div>
                          {itemCount > 1 && (
                            <div className="text-xs text-text-muted">
                              +{itemCount - 1} item{itemCount > 2 ? "s" : ""}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {firstItem
                        ? firstItem.cantidad.toLocaleString("es-CL", {
                            maximumFractionDigits: 2,
                          })
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {firstItem
                        ? firstItem.precioUnitario.toLocaleString("es-CL", {
                            maximumFractionDigits: 2,
                          })
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono whitespace-nowrap ${totalCls}`}
                    >
                      {formatMoney(totalAmt, m.currency)}
                    </td>
                    <td
                      className="px-3 py-2 max-w-md truncate"
                      title={m.observation}
                    >
                      {m.observation || <span className="text-text-dim">—</span>}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {!loading && total > movements.length && (
        <div className="text-xs text-text-muted">
          Mostrando {movements.length.toLocaleString("es-CL")} de{" "}
          {total.toLocaleString("es-CL")} movimientos. Refina los filtros para
          acotar.
        </div>
      )}

      {selected && (
        <MovementDetail
          movement={selected}
          rubroLabel={
            selected.rubro !== null ? rubroLabelMap.get(selected.rubro) ?? null : null
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
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-warn mt-1">{sub}</div>}
    </div>
  );
}
