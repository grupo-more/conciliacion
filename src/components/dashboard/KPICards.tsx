"use client";

import type { KPIData } from "./types";
import type { KPIKind } from "./KPIDetailModal";
import { formatMoney } from "@/lib/format";

interface Props {
  kpis: KPIData;
  periodLabel: string;
  onSelect?: (kind: KPIKind) => void;
}

export function KPICards({ kpis, periodLabel, onSelect }: Props) {
  const balanceChangePct = kpis.consolidatedBalanceChangePct;
  const inChangePct =
    kpis.totalInPrev > 0
      ? (kpis.totalIn - kpis.totalInPrev) / kpis.totalInPrev
      : null;
  const outChangePct =
    kpis.totalOutPrev > 0
      ? (kpis.totalOut - kpis.totalOutPrev) / kpis.totalOutPrev
      : null;
  const matchRateChange =
    kpis.autoMatchRatePrev !== null
      ? kpis.autoMatchRate - kpis.autoMatchRatePrev
      : null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 stagger">
      <Card
        label="Saldo consolidado"
        value={formatMoney(kpis.consolidatedBalance)}
        delta={
          balanceChangePct !== null
            ? formatPct(balanceChangePct, "vs anterior")
            : null
        }
        deltaPositive={
          kpis.consolidatedBalanceChange !== null
            ? kpis.consolidatedBalanceChange >= 0
            : null
        }
        onClick={onSelect ? () => onSelect("saldo") : undefined}
      />
      <Card
        label={`Ingresos · ${periodLabel.toLowerCase()}`}
        value={formatMoney(kpis.totalIn)}
        delta={inChangePct !== null ? formatPct(inChangePct, "vs anterior") : null}
        deltaPositive={inChangePct !== null ? inChangePct >= 0 : null}
        onClick={onSelect ? () => onSelect("ingresos") : undefined}
      />
      <Card
        label={`Egresos · ${periodLabel.toLowerCase()}`}
        value={formatMoney(kpis.totalOut)}
        delta={outChangePct !== null ? formatPct(outChangePct, "vs anterior") : null}
        deltaPositive={outChangePct !== null ? outChangePct <= 0 : null}
        onClick={onSelect ? () => onSelect("egresos") : undefined}
      />
      <Card
        label="Tasa conciliación auto"
        value={`${(kpis.autoMatchRate * 100).toFixed(0)}%`}
        sub={`${kpis.ventasProcessed} de ${kpis.ventasTotal} ventas procesadas`}
        delta={
          matchRateChange !== null
            ? `${matchRateChange >= 0 ? "+" : ""}${(matchRateChange * 100).toFixed(0)}pp vs anterior`
            : null
        }
        deltaPositive={matchRateChange !== null ? matchRateChange >= 0 : null}
        onClick={onSelect ? () => onSelect("tasa") : undefined}
      />
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  delta,
  deltaPositive,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string | null;
  deltaPositive?: boolean | null;
  onClick?: () => void;
}) {
  const deltaCls =
    deltaPositive === true
      ? "text-success"
      : deltaPositive === false
      ? "text-danger"
      : "text-text-muted";
  const deltaIcon =
    deltaPositive === true ? "▲" : deltaPositive === false ? "▼" : "·";

  const interactive = !!onClick;
  const Wrapper: keyof JSX.IntrinsicElements = interactive ? "button" : "div";

  return (
    <Wrapper
      onClick={onClick}
      type={interactive ? "button" : undefined}
      className={
        "card relative overflow-hidden group transition-all duration-350 ease-spring text-left w-full " +
        (interactive
          ? "cursor-pointer hover:border-accent/40 hover:shadow-card-hover hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          : "hover:border-accent/40 hover:shadow-card-hover hover:-translate-y-1")
      }
      aria-label={interactive ? `Ver detalle de ${label}` : undefined}
    >
      <div
        className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-brand via-accent to-brand-tonal scale-x-0 group-hover:scale-x-100 transition-transform duration-450 ease-out origin-left"
        aria-hidden
      />
      <div
        className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-accent/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-2xl"
        aria-hidden
      />
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold flex items-center justify-between gap-2">
        <span>{label}</span>
        {interactive && (
          <span
            className="text-[10px] text-text-dim opacity-0 group-hover:opacity-100 transition-opacity duration-300"
            aria-hidden
          >
            ver detalle →
          </span>
        )}
      </div>
      <div className="text-2xl font-bold mt-1.5 tabular-nums tracking-tight text-brand transition-colors duration-300 group-hover:text-brand-hover">
        {value}
      </div>
      {sub && <div className="text-xs text-text-muted mt-1">{sub}</div>}
      {delta && (
        <div className={`text-xs mt-2 flex items-center gap-1 ${deltaCls}`}>
          <span className="text-[10px]">{deltaIcon}</span>
          <span>{delta}</span>
        </div>
      )}
    </Wrapper>
  );
}

function formatPct(ratio: number, suffix?: string): string {
  const pct = (ratio * 100).toFixed(1);
  const sign = ratio >= 0 ? "+" : "";
  return suffix ? `${sign}${pct}% ${suffix}` : `${sign}${pct}%`;
}
