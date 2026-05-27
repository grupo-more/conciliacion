"use client";

import { useEffect, useRef, useState } from "react";
import { Alerts } from "./Alerts";
import { BalancesTable } from "./BalancesTable";
import { FlowsChart } from "./FlowsChart";
import { KPICards } from "./KPICards";
import { KPIDetailModal, type KPIKind } from "./KPIDetailModal";
import { PipelineCard } from "./PipelineCard";
import { TopBranches } from "./TopBranches";
import { TopCashiers } from "./TopCashiers";
import type { DashboardData, Period } from "./types";

const REFRESH_INTERVAL_MS = 60_000;

export function DashboardView() {
  const [period, setPeriod] = useState<Period>("month");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKPI, setSelectedKPI] = useState<KPIKind | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(silent = false) {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?period=${period}`);
      if (!res.ok) {
        setError("Error al cargar el dashboard");
        return;
      }
      const j: DashboardData = await res.json();
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => load(true), REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  const periodLabel = data?.range.label ?? "";

  return (
    <div className="space-y-5">
      {/* Header con selector de período */}
      <div className="flex flex-wrap items-start justify-between gap-3 animate-fade-in-down">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {periodLabel}
            {data && (
              <span className="ml-2 text-text-dim text-xs">
                · actualizado{" "}
                {new Date(data.generatedAt).toLocaleTimeString("es-CL", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
                {refreshing && (
                  <span className="ml-1 text-accent animate-pulse-soft">
                    · actualizando…
                  </span>
                )}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <PeriodTabs value={period} onChange={setPeriod} />
          <button
            onClick={() => load()}
            disabled={loading || refreshing}
            className="btn-ghost text-xs group"
            title="Refrescar manualmente"
            aria-label="Refrescar"
          >
            <svg
              className={
                "h-4 w-4 transition-transform duration-450 ease-spring " +
                (refreshing
                  ? "animate-spin-slow"
                  : "group-hover:rotate-180")
              }
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="py-12 text-center text-text-muted">Cargando dashboard…</div>
      )}

      {data && (
        <div className="space-y-5 animate-fade-in">
          {data.alerts.length > 0 && <Alerts alerts={data.alerts} />}

          <KPICards
            kpis={data.kpis}
            periodLabel={periodLabel}
            onSelect={setSelectedKPI}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <BalancesTable balances={data.balances} periodLabel={periodLabel} />
              <FlowsChart flows={data.flows} periodLabel={periodLabel} />
            </div>
            <div className="space-y-4">
              <PipelineCard pipeline={data.pipeline} />
              <TopBranches branches={data.topBranches} />
              <TopCashiers cashiers={data.topCashiers} />
            </div>
          </div>

          {data.alerts.length === 0 && <Alerts alerts={data.alerts} />}
        </div>
      )}

      {/* Modal de detalle de KPI */}
      {selectedKPI && data && (
        <KPIDetailModal
          kind={selectedKPI}
          balances={data.balances}
          pipeline={data.pipeline}
          periodLabel={periodLabel}
          onClose={() => setSelectedKPI(null)}
        />
      )}
    </div>
  );
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const opts: Array<{ id: Period; label: string }> = [
    { id: "day", label: "Día" },
    { id: "week", label: "Semana" },
    { id: "month", label: "Mes" },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border-soft bg-white p-0.5 shadow-soft">
      {opts.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={
              "px-3 py-1.5 text-xs font-semibold rounded-md transition-all duration-300 ease-out " +
              (active
                ? "bg-brand text-white shadow-brand scale-100"
                : "text-text-muted hover:text-brand hover:bg-brand-tint")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
