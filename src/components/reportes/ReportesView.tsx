"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import type { ReportesOverview } from "./types";
import { BancoSinConciliarView } from "./BancoSinConciliarView";
import { DynatechSinContraparteView } from "./DynatechSinContraparteView";

type Tab = "banco" | "dynatech";

/**
 * Módulo Reportes: vista de la brecha de conciliación con sub-tabs (Banco /
 * Dynatech) y una franja de resumen cruzado arriba que muestra ambos lados.
 * El rango de fecha es compartido entre la franja y la tab activa.
 */
export function ReportesView() {
  const [tab, setTab] = useState<Tab>("banco");
  const [from, setFrom] = useState(firstDayOfMonthIso());
  const [to, setTo] = useState(todayIso());

  const [overview, setOverview] = useState<ReportesOverview | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const p = new URLSearchParams({ from, to });
      const res = await fetch(`/api/reportes/overview?${p}`);
      if (!res.ok) return;
      const d = await res.json();
      if (!cancel) setOverview(d);
    })();
    return () => {
      cancel = true;
    };
  }, [from, to]);

  function onRangeChange(f: string, t: string) {
    setFrom(f);
    setTo(t);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-brand">Reportes</h1>
        <p className="text-xs text-text-muted mt-0.5">
          Brecha de conciliación: qué falta cuadrar y por qué — exportable a Excel
        </p>
      </div>

      {/* Resumen cruzado */}
      <div className="grid gap-3 sm:grid-cols-2">
        <CrossCard
          title="Banco sin conciliar"
          subtitle="Movimientos de cartola sin contraparte en Dynatech"
          count={overview?.banco.count ?? 0}
          monto={overview?.banco.monto ?? "0"}
          breakdown={
            overview
              ? `IN: ${overview.banco.in.count} (${formatMoney(BigInt(overview.banco.in.monto))}) · OUT: ${overview.banco.out.count} (${formatMoney(BigInt(overview.banco.out.monto))})`
              : ""
          }
          active={tab === "banco"}
          onClick={() => setTab("banco")}
        />
        <CrossCard
          title="Dynatech sin contraparte"
          subtitle="Movimientos de Tesorería sin conciliar en banco"
          count={overview?.dynatech.count ?? 0}
          monto={overview?.dynatech.monto ?? "0"}
          breakdown={
            overview
              ? `Ingresos: ${overview.dynatech.ingreso.count} (${formatMoney(BigInt(overview.dynatech.ingreso.monto))}) · Egresos: ${overview.dynatech.egreso.count} (${formatMoney(BigInt(overview.dynatech.egreso.monto))})`
              : ""
          }
          active={tab === "dynatech"}
          onClick={() => setTab("dynatech")}
        />
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-border-soft">
        <nav className="flex gap-1">
          <TabButton active={tab === "banco"} onClick={() => setTab("banco")}>
            Banco sin conciliar
          </TabButton>
          <TabButton active={tab === "dynatech"} onClick={() => setTab("dynatech")}>
            Dynatech sin contraparte
          </TabButton>
        </nav>
      </div>

      {/* Contenido */}
      {tab === "banco" && (
        <BancoSinConciliarView from={from} to={to} onRangeChange={onRangeChange} />
      )}
      {tab === "dynatech" && (
        <DynatechSinContraparteView
          from={from}
          to={to}
          onRangeChange={onRangeChange}
        />
      )}
    </div>
  );
}

function CrossCard({
  title,
  subtitle,
  count,
  monto,
  breakdown,
  active,
  onClick,
}: {
  title: string;
  subtitle: string;
  count: number;
  monto: string;
  breakdown: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "text-left rounded-lg border p-4 transition-all " +
        (active
          ? "border-brand bg-brand/5 shadow-brand"
          : "border-border-soft bg-white hover:border-brand/40")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-brand">{title}</div>
          <div className="text-[11px] text-text-muted">{subtitle}</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums text-rose-600">
            {count.toLocaleString("es-CL")}
          </div>
          <div className="text-sm font-mono text-text-muted">
            {formatMoney(BigInt(monto))}
          </div>
        </div>
      </div>
      {breakdown && (
        <div className="mt-2 text-[11px] text-text-dim">{breakdown}</div>
      )}
    </button>
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

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstDayOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
