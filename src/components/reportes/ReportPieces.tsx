"use client";

import { formatMoney } from "@/lib/format";
import {
  AGING_BUCKETS,
  AGING_LABEL,
  type AgingBucket,
  type AmountCell,
} from "./types";

/** Tarjeta KPI: número grande + monto + sublabel opcional. */
export function KpiCard({
  label,
  count,
  monto,
  tone = "neutral",
  sub,
}: {
  label: string;
  count: number;
  monto: string;
  tone?: "neutral" | "danger" | "brand";
  sub?: React.ReactNode;
}) {
  const toneCls =
    tone === "danger"
      ? "text-rose-600"
      : tone === "brand"
        ? "text-brand"
        : "text-text";
  return (
    <div className="rounded-lg border border-border-soft bg-white px-4 py-3 min-w-[160px]">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${toneCls}`}>
        {count.toLocaleString("es-CL")}
      </div>
      <div className="text-sm font-mono text-text-muted">
        {formatMoney(BigInt(monto))}
      </div>
      {sub && <div className="mt-1 text-[11px] text-text-dim">{sub}</div>}
    </div>
  );
}

/** Barra apilada de aging — la señal operativa: cuánto pendiente y qué tan viejo. */
export function AgingBar({
  porAging,
}: {
  porAging: Record<AgingBucket, AmountCell>;
}) {
  const total = AGING_BUCKETS.reduce((s, b) => s + (porAging[b]?.count ?? 0), 0);
  const COLORS: Record<AgingBucket, string> = {
    "0-7": "bg-emerald-400",
    "8-30": "bg-amber-400",
    "31-60": "bg-orange-500",
    "60+": "bg-rose-600",
  };
  return (
    <div className="rounded-lg border border-border-soft bg-white px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-text-muted">Antigüedad (aging)</div>
        {total > 0 && (porAging["60+"]?.count ?? 0) > 0 && (
          <span className="text-[11px] font-semibold text-rose-600">
            ⚠ {porAging["60+"].count} con +60 días
          </span>
        )}
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-soft">
        {AGING_BUCKETS.map((b) => {
          const c = porAging[b]?.count ?? 0;
          const pct = total > 0 ? (c / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={b}
              className={COLORS[b]}
              style={{ width: `${pct}%` }}
              title={`${AGING_LABEL[b]}: ${c}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {AGING_BUCKETS.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${COLORS[b]}`} />
            <span className="text-text-muted">{AGING_LABEL[b]}:</span>
            <strong className="tabular-nums">{porAging[b]?.count ?? 0}</strong>
            <span className="font-mono text-text-dim">
              {formatMoney(BigInt(porAging[b]?.monto ?? "0"))}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Desglose genérico: filas {label, count, monto} ordenadas por monto. */
export function Breakdown({
  title,
  rows,
  max = 8,
}: {
  title: string;
  rows: { label: string; count: number; monto: string }[];
  max?: number;
}) {
  const visible = rows.filter((r) => r.count > 0).slice(0, max);
  return (
    <div className="rounded-lg border border-border-soft bg-white px-4 py-3">
      <div className="text-xs text-text-muted mb-2">{title}</div>
      {visible.length === 0 ? (
        <div className="text-xs text-text-dim">—</div>
      ) : (
        <div className="space-y-1">
          {visible.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="truncate" title={r.label}>
                {r.label}
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-text-dim tabular-nums">
                  {r.count}
                </span>
                <span className="font-mono text-text-muted">
                  {formatMoney(BigInt(r.monto))}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Chips de desglose por categoría con color (tags / motivos). */
export function CategoryChips({
  title,
  items,
}: {
  title: string;
  items: {
    key: string;
    label: string;
    count: number;
    monto: string;
    cls: string;
  }[];
}) {
  const visible = items.filter((i) => i.count > 0);
  return (
    <div className="rounded-lg border border-border-soft bg-white px-4 py-3">
      <div className="text-xs text-text-muted mb-2">{title}</div>
      {visible.length === 0 ? (
        <div className="text-xs text-text-dim">—</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {visible.map((i) => (
            <span
              key={i.key}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${i.cls}`}
              title={formatMoney(BigInt(i.monto))}
            >
              {i.label}
              <span className="tabular-nums opacity-80">{i.count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
