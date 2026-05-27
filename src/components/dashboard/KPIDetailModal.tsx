"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatMoney, formatDate } from "@/lib/format";
import type { AccountBalance, PipelineData } from "./types";

export type KPIKind = "saldo" | "ingresos" | "egresos" | "tasa";

interface Props {
  kind: KPIKind;
  balances: AccountBalance[];
  pipeline: PipelineData;
  periodLabel: string;
  onClose: () => void;
}

const TITLES: Record<KPIKind, string> = {
  saldo: "Saldo por cuenta",
  ingresos: "Ingresos por cuenta",
  egresos: "Egresos por cuenta",
  tasa: "Conciliación por cuenta",
};

const SUBTITLES: Record<KPIKind, string> = {
  saldo: "Estado actual y variación desde el inicio del período",
  ingresos: "Lo que entró a cada cuenta y cuánto está conciliado",
  egresos: "Lo que salió de cada cuenta y flujo neto",
  tasa: "Avance de conciliación por cuenta · pendientes accionables",
};

export function KPIDetailModal({
  kind,
  balances,
  pipeline,
  periodLabel,
  onClose,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel max-w-5xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              {TITLES[kind]}
            </h2>
            <div className="text-xs text-text-muted mt-0.5">
              {SUBTITLES[kind]} · {periodLabel}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {kind === "saldo" && <SaldoView balances={balances} />}
        {kind === "ingresos" && <IngresosView balances={balances} />}
        {kind === "egresos" && <EgresosView balances={balances} />}
        {kind === "tasa" && (
          <TasaView balances={balances} pipeline={pipeline} />
        )}
      </div>
    </div>,
    document.body
  );
}

/* ============================== SALDO ============================== */

function SaldoView({ balances }: { balances: AccountBalance[] }) {
  const sorted = balances.slice().sort((a, b) => b.balance - a.balance);
  const totalNow = sorted.reduce((s, b) => s + b.balance, 0);
  const totalStart = sorted.reduce((s, b) => s + b.balanceAtStart, 0);
  const totalDelta = totalNow - totalStart;

  return (
    <div className="space-y-4">
      <SummaryStrip
        items={[
          { label: "Saldo total actual", value: formatMoney(totalNow), tone: "brand" },
          {
            label: "Saldo al inicio del período",
            value: formatMoney(totalStart),
            tone: "muted",
          },
          {
            label: "Variación neta",
            value:
              (totalDelta >= 0 ? "+" : "") + formatMoney(totalDelta),
            tone: totalDelta >= 0 ? "good" : "bad",
          },
        ]}
      />

      <div className="space-y-2">
        {sorted.map((b) => (
          <SaldoCard key={b.id} b={b} totalNow={totalNow} />
        ))}
      </div>
    </div>
  );
}

function SaldoCard({ b, totalNow }: { b: AccountBalance; totalNow: number }) {
  const pct = totalNow > 0 ? (b.balance / totalNow) * 100 : 0;
  const delta = b.balance - b.balanceAtStart;
  const deltaPct =
    b.balanceAtStart !== 0 ? (delta / Math.abs(b.balanceAtStart)) * 100 : null;
  const fresh = freshness(b.daysSinceLastMovement);
  return (
    <div className="rounded-md border border-border-soft bg-white p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-sm">
            {b.bankName} <span className="text-text-muted font-mono">· {b.accountNumber}</span>
          </div>
          <div className="text-xs text-text-muted">{b.holderName}</div>
          <div className={`text-xs mt-1 ${fresh.cls}`}>
            {b.lastMovementDate
              ? `Última actividad: ${fresh.label}${
                  b.daysSinceLastMovement && b.daysSinceLastMovement > 0
                    ? ` (${formatDate(b.lastMovementDate)})`
                    : ""
                }`
              : "Sin movimientos"}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono font-bold text-lg">{formatMoney(b.balance)}</div>
          <div className="text-xs text-text-muted">{pct.toFixed(1)}% del total</div>
        </div>
      </div>

      {/* Barra del % del total */}
      <div className="mt-2 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
        <div
          className="h-full bg-brand/70 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-text-muted">Saldo al inicio</div>
          <div className="font-mono">{formatMoney(b.balanceAtStart)}</div>
        </div>
        <div>
          <div className="text-text-muted">Variación</div>
          <div className={`font-mono font-semibold ${delta >= 0 ? "text-success" : "text-danger"}`}>
            {delta >= 0 ? "+" : ""}{formatMoney(delta)}
            {deltaPct !== null && (
              <span className="ml-1 text-[10px]">({deltaPct >= 0 ? "+" : ""}{deltaPct.toFixed(1)}%)</span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-text-muted">Movimientos</div>
          <div className="font-mono">{b.movementCountInPeriod}</div>
        </div>
      </div>
    </div>
  );
}

/* ============================== INGRESOS ============================== */

function IngresosView({ balances }: { balances: AccountBalance[] }) {
  const sorted = balances.slice().sort((a, b) => b.inSumInPeriod - a.inSumInPeriod);
  const totalIn = sorted.reduce((s, b) => s + b.inSumInPeriod, 0);
  const totalRec = sorted.reduce((s, b) => s + b.reconciledInSum, 0);
  const totalUnrec = sorted.reduce((s, b) => s + b.unreconciledInSum, 0);
  const pctRec = totalIn > 0 ? (totalRec / totalIn) * 100 : 0;

  return (
    <div className="space-y-4">
      <SummaryStrip
        items={[
          { label: "Total ingresado", value: formatMoney(totalIn), tone: "brand" },
          {
            label: "Conciliado",
            value: `${formatMoney(totalRec)} (${pctRec.toFixed(0)}%)`,
            tone: "good",
          },
          {
            label: "Sin matchear",
            value: formatMoney(totalUnrec),
            tone: "bad",
          },
        ]}
      />

      <div className="space-y-2">
        {sorted.map((b) => (
          <IngresoCard key={b.id} b={b} />
        ))}
      </div>
    </div>
  );
}

function IngresoCard({ b }: { b: AccountBalance }) {
  const avg = b.inCountInPeriod > 0 ? b.inSumInPeriod / b.inCountInPeriod : 0;
  const pctRec =
    b.inSumInPeriod > 0 ? (b.reconciledInSum / b.inSumInPeriod) * 100 : 0;
  const pctUnrec = 100 - pctRec;
  const hasIn = b.inSumInPeriod > 0;

  return (
    <div className="rounded-md border border-border-soft bg-white p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-sm">
            {b.bankName} <span className="text-text-muted font-mono">· {b.accountNumber}</span>
          </div>
          <div className="text-xs text-text-muted">{b.holderName}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono font-bold text-lg text-success">
            +{formatMoney(b.inSumInPeriod)}
          </div>
          <div className="text-xs text-text-muted">
            {b.inCountInPeriod} depósito{b.inCountInPeriod !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {hasIn && (
        <>
          {/* Barra conciliado vs sin matchear */}
          <div className="mt-3 flex h-2.5 rounded-full overflow-hidden bg-bg-elevated ring-1 ring-border-soft">
            {pctRec > 0 && (
              <div
                className="bg-success/80"
                style={{ width: `${pctRec}%` }}
                title={`Conciliado: ${pctRec.toFixed(1)}%`}
              />
            )}
            {pctUnrec > 0 && (
              <div
                className="bg-warn/70"
                style={{ width: `${pctUnrec}%` }}
                title={`Sin matchear: ${pctUnrec.toFixed(1)}%`}
              />
            )}
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-success flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-success/80 rounded-sm" />
                Conciliado
              </div>
              <div className="font-mono">
                {formatMoney(b.reconciledInSum)}
                <span className="text-text-muted ml-1">({b.reconciledInCount})</span>
              </div>
            </div>
            <div>
              <div className="text-warn flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-warn/70 rounded-sm" />
                Sin matchear
              </div>
              <div className="font-mono">
                {formatMoney(b.unreconciledInSum)}
                <span className="text-text-muted ml-1">({b.unreconciledInCount})</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-text-muted">Promedio depósito</div>
              <div className="font-mono">{formatMoney(avg)}</div>
            </div>
          </div>
        </>
      )}

      {!hasIn && (
        <div className="mt-3 text-xs text-text-muted italic">Sin ingresos en el período.</div>
      )}
    </div>
  );
}

/* ============================== EGRESOS ============================== */

function EgresosView({ balances }: { balances: AccountBalance[] }) {
  const sorted = balances.slice().sort((a, b) => b.outSumInPeriod - a.outSumInPeriod);
  const totalIn = sorted.reduce((s, b) => s + b.inSumInPeriod, 0);
  const totalOut = sorted.reduce((s, b) => s + b.outSumInPeriod, 0);
  const net = totalIn - totalOut;

  return (
    <div className="space-y-4">
      <SummaryStrip
        items={[
          { label: "Total egresado", value: formatMoney(totalOut), tone: "brand" },
          { label: "Total ingresado", value: formatMoney(totalIn), tone: "muted" },
          {
            label: "Flujo neto del período",
            value: (net >= 0 ? "+" : "") + formatMoney(net),
            tone: net >= 0 ? "good" : "bad",
          },
        ]}
      />

      <div className="space-y-2">
        {sorted.map((b) => (
          <EgresoCard key={b.id} b={b} />
        ))}
      </div>
    </div>
  );
}

function EgresoCard({ b }: { b: AccountBalance }) {
  const avg = b.outCountInPeriod > 0 ? b.outSumInPeriod / b.outCountInPeriod : 0;
  const neto = b.inSumInPeriod - b.outSumInPeriod;
  const hasOut = b.outSumInPeriod > 0;

  return (
    <div className="rounded-md border border-border-soft bg-white p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-sm">
            {b.bankName} <span className="text-text-muted font-mono">· {b.accountNumber}</span>
          </div>
          <div className="text-xs text-text-muted">{b.holderName}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono font-bold text-lg text-danger">
            −{formatMoney(b.outSumInPeriod)}
          </div>
          <div className="text-xs text-text-muted">
            {b.outCountInPeriod} salida{b.outCountInPeriod !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {hasOut && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-text-muted">Ingresos del período</div>
            <div className="font-mono text-success">+{formatMoney(b.inSumInPeriod)}</div>
          </div>
          <div>
            <div className="text-text-muted">Promedio salida</div>
            <div className="font-mono">{formatMoney(avg)}</div>
          </div>
          <div className="text-right">
            <div className="text-text-muted">Neto del período</div>
            <div className={`font-mono font-semibold ${neto >= 0 ? "text-success" : "text-danger"}`}>
              {neto >= 0 ? "+" : ""}{formatMoney(neto)}
            </div>
          </div>
        </div>
      )}

      {!hasOut && (
        <div className="mt-3 text-xs text-text-muted italic">Sin egresos en el período.</div>
      )}
    </div>
  );
}

/* ============================== TASA CONCILIACIÓN ============================== */

function TasaView({
  balances,
  pipeline,
}: {
  balances: AccountBalance[];
  pipeline: PipelineData;
}) {
  const sorted = balances.slice().sort((a, b) => b.inCountInPeriod - a.inCountInPeriod);
  const totalIn = sorted.reduce((s, b) => s + b.inCountInPeriod, 0);
  const totalRec = sorted.reduce((s, b) => s + b.reconciledInCount, 0);
  const totalUnrec = totalIn - totalRec;
  const pctOk = totalIn > 0 ? (totalRec / totalIn) * 100 : 0;

  return (
    <div className="space-y-4">
      <SummaryStrip
        items={[
          {
            label: "Avance global (ingresos bancarios)",
            value: `${pctOk.toFixed(0)}%`,
            tone: "brand",
          },
          {
            label: "Conciliados",
            value: `${totalRec} de ${totalIn}`,
            tone: "good",
          },
          {
            label: "Sin matchear",
            value: `${totalUnrec}${
              pipeline.backlogOver7d > 0
                ? ` · ${pipeline.backlogOver7d} con +7d`
                : ""
            }`,
            tone: totalUnrec > 0 ? "bad" : "muted",
          },
        ]}
      />

      <div className="space-y-2">
        {sorted.map((b) => (
          <TasaCard key={b.id} b={b} />
        ))}
      </div>
    </div>
  );
}

function TasaCard({ b }: { b: AccountBalance }) {
  const hasIn = b.inCountInPeriod > 0;
  const pct = hasIn ? (b.reconciledInCount / b.inCountInPeriod) * 100 : 0;
  const tone = !hasIn
    ? "muted"
    : pct >= 90
    ? "success"
    : pct >= 60
    ? "warn"
    : "danger";
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "warn"
      ? "text-warn"
      : tone === "danger"
      ? "text-danger"
      : "text-text-muted";
  const barCls =
    tone === "success"
      ? "bg-success/80"
      : tone === "warn"
      ? "bg-warn/70"
      : tone === "danger"
      ? "bg-danger/70"
      : "bg-text-muted/30";

  return (
    <div className="rounded-md border border-border-soft bg-white p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-semibold text-sm">
            {b.bankName} <span className="text-text-muted font-mono">· {b.accountNumber}</span>
          </div>
          <div className="text-xs text-text-muted">{b.holderName}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-bold text-lg ${toneCls}`}>{pct.toFixed(0)}%</div>
          <div className="text-xs text-text-muted">
            {b.reconciledInCount} / {b.inCountInPeriod} ingresos
          </div>
        </div>
      </div>

      {hasIn ? (
        <>
          <div className="mt-3 h-2 bg-bg-elevated rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-success">Conciliado</div>
              <div className="font-mono">
                {formatMoney(b.reconciledInSum)}{" "}
                <span className="text-text-muted">({b.reconciledInCount})</span>
              </div>
            </div>
            <div>
              <div className="text-warn">Pendiente</div>
              <div className="font-mono">
                {formatMoney(b.unreconciledInSum)}{" "}
                <span className="text-text-muted">({b.unreconciledInCount})</span>
              </div>
            </div>
            <div className="text-right">
              {b.unreconciledInCount > 0 ? (
                <a
                  href={`/dashboard/consolidados?accountId=${b.id}`}
                  className="text-xs text-brand hover:underline"
                >
                  Ver pendientes →
                </a>
              ) : (
                <span className="text-xs text-success">✓ Al día</span>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="mt-3 text-xs text-text-muted italic">Sin ingresos en el período.</div>
      )}
    </div>
  );
}

/* ============================== Helpers ============================== */

function SummaryStrip({
  items,
}: {
  items: Array<{ label: string; value: string; tone: "brand" | "good" | "bad" | "muted" }>;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {items.map((it) => {
        const tone =
          it.tone === "brand"
            ? "text-brand"
            : it.tone === "good"
            ? "text-success"
            : it.tone === "bad"
            ? "text-danger"
            : "text-text-muted";
        return (
          <div
            key={it.label}
            className="rounded-md border border-border-soft bg-bg-soft/40 px-3 py-2"
          >
            <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">
              {it.label}
            </div>
            <div className={`text-lg font-bold tabular-nums mt-0.5 ${tone}`}>
              {it.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function freshness(days: number | null): { label: string; cls: string } {
  if (days === null) return { label: "sin datos", cls: "text-text-dim" };
  if (days <= 1) return { label: "al día", cls: "text-success" };
  if (days <= 3) return { label: `hace ${days} día${days === 1 ? "" : "s"}`, cls: "text-success" };
  if (days <= 7) return { label: `hace ${days} días`, cls: "text-warn" };
  return { label: `hace ${days} días ⚠`, cls: "text-danger" };
}
