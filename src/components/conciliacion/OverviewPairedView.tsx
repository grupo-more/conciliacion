"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DetailModal } from "./DetailModal";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type {
  OverviewBank,
  OverviewKpis,
  OverviewOrphanRow,
  OverviewPairRow,
  OverviewResponse,
  OverviewRow,
  OverviewStatus,
} from "./overview-types";

type Period = "day" | "week" | "month";

const REFRESH_MS = 60_000;

const STATUS_META: Record<
  OverviewStatus,
  { label: string; cls: string; rowCls: string }
> = {
  AUTO_MATCHED: {
    label: "Auto",
    cls: "border-success/40 text-success bg-success/10",
    rowCls: "bg-success/[0.06] hover:bg-success/[0.12]",
  },
  MANUAL: {
    label: "Manual",
    cls: "border-success/40 text-success bg-success/10",
    rowCls: "bg-success/[0.06] hover:bg-success/[0.12]",
  },
  SUGGESTED: {
    label: "Sugerido",
    cls: "border-brand/40 text-brand bg-brand/10",
    rowCls: "bg-brand/[0.06] hover:bg-brand/[0.12]",
  },
  REVIEW: {
    label: "Revisar",
    cls: "border-warn/40 text-warn bg-warn/10",
    rowCls: "bg-warn/[0.06] hover:bg-warn/[0.12]",
  },
  NO_MATCH: {
    label: "Sin match",
    cls: "border-text-muted/40 text-text-muted bg-bg-card",
    rowCls: "bg-danger/[0.04] hover:bg-danger/[0.10]",
  },
  OUT_OF_SCOPE: {
    label: "Fuera scope",
    cls: "border-text-muted/40 text-text-muted bg-bg-card",
    rowCls: "hover:bg-bg-soft/50",
  },
  UNPROCESSED: {
    label: "Pendiente",
    cls: "border-text-muted/40 text-text-muted bg-bg-card",
    rowCls: "hover:bg-bg-soft/50",
  },
  UNPAIRED_BANK: {
    label: "Sin par Dynatech",
    cls: "border-warn/40 text-warn bg-warn/10",
    rowCls: "bg-warn/[0.04] hover:bg-warn/[0.10]",
  },
};

// Estados visibles como toggles de filtro (omitimos UNPROCESSED — se agrupa con pendientes en KPIs).
const STATUS_FILTER_TOGGLES: OverviewStatus[] = [
  "AUTO_MATCHED",
  "MANUAL",
  "SUGGESTED",
  "REVIEW",
  "NO_MATCH",
  "OUT_OF_SCOPE",
  "UNPROCESSED",
  "UNPAIRED_BANK",
];

export function OverviewPairedView() {
  const [period, setPeriod] = useState<Period>("month");
  const [branchId, setBranchId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [enabledStatuses, setEnabledStatuses] = useState<Set<OverviewStatus>>(
    () => new Set(STATUS_FILTER_TOGGLES)
  );
  const [search, setSearch] = useState("");

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  // Selección abierta (par Dynatech → DetailModal; orphan banco → modal mini)
  const [openReconciliationId, setOpenReconciliationId] = useState<string | null>(null);
  const [openOrphanBank, setOpenOrphanBank] = useState<OverviewBank | null>(null);

  // Hover cross-highlight
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load(silent = false) {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const params = new URLSearchParams({ period });
      if (branchId) params.set("branchId", branchId);
      if (accountId) params.set("accountId", accountId);
      // Solo enviar status filter si NO todos están activos (URL más corta)
      if (enabledStatuses.size !== STATUS_FILTER_TOGGLES.length) {
        params.set("status", Array.from(enabledStatuses).join(","));
      }
      if (search.trim()) params.set("q", search.trim());

      const res = await fetch(`/api/reconciliation/overview?${params}`);
      if (!res.ok) return;
      const json: OverviewResponse = await res.json();
      setData(json);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function runMatching() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/reconciliation/run", { method: "POST" });
      const j = await res.json();
      setRunResult(
        `Procesados ${j.processed} · Auto ${j.autoMatched} · Sug ${j.suggested} · Rev ${j.review} · Sin ${j.noMatch} · Fuera ${j.outOfScope}`
      );
      await load(true);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, branchId, accountId, enabledStatuses]);

  // Búsqueda con debounce
  useEffect(() => {
    const t = setTimeout(() => load(true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  useEffect(() => {
    if (runResult) {
      const t = setTimeout(() => setRunResult(null), 5000);
      return () => clearTimeout(t);
    }
  }, [runResult]);

  function toggleStatus(s: OverviewStatus) {
    setEnabledStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function selectAllStatuses() {
    setEnabledStatuses(new Set(STATUS_FILTER_TOGGLES));
  }

  function selectOnlyPending() {
    setEnabledStatuses(
      new Set(["SUGGESTED", "REVIEW", "NO_MATCH", "UNPROCESSED", "UNPAIRED_BANK"])
    );
  }

  function handleRowClick(row: OverviewRow) {
    if (row.kind === "PAIR") {
      if (row.dynatech.reconciliationId) {
        setOpenReconciliationId(row.dynatech.reconciliationId);
      }
    } else {
      setOpenOrphanBank(row.bank);
    }
  }

  return (
    <div className="space-y-5">
      <Header
        period={period}
        onPeriodChange={setPeriod}
        rangeLabel={data?.range.label ?? ""}
        generatedAt={data?.generatedAt ?? null}
        refreshing={refreshing}
        running={running}
        onRun={runMatching}
      />

      {runResult && (
        <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          ✓ {runResult}
        </div>
      )}

      <KpisBar kpis={data?.kpis ?? null} />

      <FiltersBar
        branchId={branchId}
        onBranchChange={setBranchId}
        accountId={accountId}
        onAccountChange={setAccountId}
        search={search}
        onSearchChange={setSearch}
        facets={data?.facets ?? null}
        enabledStatuses={enabledStatuses}
        onToggleStatus={toggleStatus}
        onSelectAllStatuses={selectAllStatuses}
        onSelectOnlyPending={selectOnlyPending}
      />

      <PairedTable
        loading={loading}
        rows={data?.rows ?? []}
        onRowClick={handleRowClick}
        hoveredRowKey={hoveredRowKey}
        onHover={setHoveredRowKey}
      />

      {openReconciliationId && (
        <DetailModal
          reconciliationId={openReconciliationId}
          onClose={() => setOpenReconciliationId(null)}
          onChanged={() => {
            load(true);
          }}
        />
      )}

      {openOrphanBank && (
        <OrphanBankModal
          bank={openOrphanBank}
          onClose={() => setOpenOrphanBank(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------- Header ----------------------------- */

function Header({
  period,
  onPeriodChange,
  rangeLabel,
  generatedAt,
  refreshing,
  running,
  onRun,
}: {
  period: Period;
  onPeriodChange: (p: Period) => void;
  rangeLabel: string;
  generatedAt: string | null;
  refreshing: boolean;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Conciliación</h1>
        <p className="text-sm text-text-muted">
          {rangeLabel}
          {generatedAt && (
            <span className="ml-2 text-text-dim text-xs">
              · actualizado{" "}
              {new Date(generatedAt).toLocaleTimeString("es-CL", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
              {refreshing && " · actualizando…"}
            </span>
          )}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <PeriodTabs value={period} onChange={onPeriodChange} />
        <button onClick={onRun} disabled={running} className="btn-primary">
          {running ? "Procesando…" : "Procesar matching"}
        </button>
      </div>
    </div>
  );
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: Period;
  onChange: (v: Period) => void;
}) {
  const items: Array<{ id: Period; label: string }> = [
    { id: "day", label: "Hoy" },
    { id: "week", label: "7 días" },
    { id: "month", label: "Mes" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border-soft overflow-hidden">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          className={
            "px-3 py-1.5 text-sm transition-colors " +
            (value === it.id
              ? "bg-brand/20 text-brand"
              : "bg-bg-card text-text-muted hover:bg-bg-soft")
          }
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------- KPIs ----------------------------- */

function KpisBar({ kpis }: { kpis: OverviewKpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card animate-pulse h-20" />
        ))}
      </div>
    );
  }

  const total =
    kpis.conciliated.count + kpis.pending.count + kpis.outOfScope.count;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        label="Conciliado"
        count={kpis.conciliated.count}
        sum={kpis.conciliated.sum}
        pct={pct(kpis.conciliated.count)}
        color="text-success"
      />
      <KpiCard
        label="Pendiente"
        count={kpis.pending.count}
        sum={kpis.pending.sum}
        pct={pct(kpis.pending.count)}
        color="text-warn"
      />
      <KpiCard
        label="Fuera de scope"
        count={kpis.outOfScope.count}
        sum={kpis.outOfScope.sum}
        pct={pct(kpis.outOfScope.count)}
        color="text-text-muted"
      />
      <KpiCard
        label="Abonos sin par Dyna"
        count={kpis.unpairedBank.count}
        sum={kpis.unpairedBank.sum}
        pct={null}
        color="text-brand"
      />
    </div>
  );
}

function KpiCard({
  label,
  count,
  sum,
  pct,
  color,
}: {
  label: string;
  count: number;
  sum: number;
  pct: number | null;
  color: string;
}) {
  return (
    <div className="card">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${color}`}>
        {pct !== null ? `${pct}%` : count.toLocaleString("es-CL")}
      </div>
      <div className="text-xs text-text-muted mt-1">
        {pct !== null
          ? `${count.toLocaleString("es-CL")} movs · ${formatMoney(sum)}`
          : formatMoney(sum)}
      </div>
    </div>
  );
}

/* ----------------------------- Filters ----------------------------- */

function FiltersBar({
  branchId,
  onBranchChange,
  accountId,
  onAccountChange,
  search,
  onSearchChange,
  facets,
  enabledStatuses,
  onToggleStatus,
  onSelectAllStatuses,
  onSelectOnlyPending,
}: {
  branchId: string;
  onBranchChange: (v: string) => void;
  accountId: string;
  onAccountChange: (v: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
  facets: OverviewResponse["facets"] | null;
  enabledStatuses: Set<OverviewStatus>;
  onToggleStatus: (s: OverviewStatus) => void;
  onSelectAllStatuses: () => void;
  onSelectOnlyPending: () => void;
}) {
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar</label>
          <input
            className="input"
            placeholder="Observación, cliente, RUT, glosa banco…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Sucursal</label>
          <select
            className="input"
            value={branchId}
            onChange={(e) => onBranchChange(e.target.value)}
          >
            <option value="">Todas</option>
            {facets?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? `#${b.id}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Cuenta bancaria</label>
          <select
            className="input"
            value={accountId}
            onChange={(e) => onAccountChange(e.target.value)}
          >
            <option value="">Todas</option>
            {facets?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.holderName} · {a.bankName} {a.displayNumber ?? a.accountNumber}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-muted">Estado:</span>
        {STATUS_FILTER_TOGGLES.map((s) => {
          const on = enabledStatuses.has(s);
          const meta = STATUS_META[s];
          return (
            <button
              key={s}
              onClick={() => onToggleStatus(s)}
              className={
                "text-xs rounded-md border px-2 py-0.5 transition-colors " +
                (on ? meta.cls : "border-border-soft text-text-dim hover:text-text-muted")
              }
            >
              {meta.label}
            </button>
          );
        })}
        <div className="ml-auto flex gap-2">
          <button
            onClick={onSelectAllStatuses}
            className="text-xs text-text-muted hover:text-text underline"
          >
            Todos
          </button>
          <button
            onClick={onSelectOnlyPending}
            className="text-xs text-text-muted hover:text-text underline"
          >
            Solo pendientes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Tabla pareada ----------------------------- */

function PairedTable({
  loading,
  rows,
  onRowClick,
  hoveredRowKey,
  onHover,
}: {
  loading: boolean;
  rows: OverviewRow[];
  onRowClick: (r: OverviewRow) => void;
  hoveredRowKey: string | null;
  onHover: (k: string | null) => void;
}) {
  // Calcular las "filas internas" para layout en grid. Cada item externo se
  // expande a max(1, banks.length) filas internas para mantener alineación
  // pareada (1 venta Dynatech ocupa N filas si hay 1:N).
  const layoutRows = useMemo(() => buildLayoutRows(rows), [rows]);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="grid grid-cols-2 border-b border-border-soft text-xs uppercase text-text-muted bg-bg-soft">
        <div className="px-3 py-2 border-r border-border-soft">Ventas Dynatech</div>
        <div className="px-3 py-2">Abonos banco</div>
      </div>

      {loading && (
        <div className="px-3 py-10 text-center text-text-muted">Cargando…</div>
      )}

      {!loading && rows.length === 0 && (
        <div className="px-3 py-10 text-center text-text-muted">
          Sin movimientos en el período seleccionado.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="divide-y divide-border-soft">
          {layoutRows.map((lr) => (
            <PairedRow
              key={lr.key}
              row={lr}
              onClick={() => onRowClick(lr.source)}
              hovered={hoveredRowKey === lr.key}
              onHover={(h) => onHover(h ? lr.key : null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface LayoutRow {
  key: string;
  source: OverviewRow;
}

function buildLayoutRows(rows: OverviewRow[]): LayoutRow[] {
  return rows.map((r) => ({
    key: r.kind === "PAIR" ? `pair:${r.dynatech.id}` : `bank:${r.bank.id}`,
    source: r,
  }));
}

function PairedRow({
  row,
  onClick,
  hovered,
  onHover,
}: {
  row: LayoutRow;
  onClick: () => void;
  hovered: boolean;
  onHover: (h: boolean) => void;
}) {
  const src = row.source;
  const status = src.status;
  const meta = STATUS_META[status];

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={
        "grid grid-cols-2 cursor-pointer transition-colors " +
        meta.rowCls +
        (hovered ? " ring-1 ring-inset ring-brand/30" : "")
      }
    >
      {/* Lado Dynatech */}
      <div className="px-3 py-2 border-r border-border-soft min-h-[60px]">
        {src.kind === "PAIR" ? (
          <DynatechCell row={src} meta={meta} />
        ) : (
          <EmptyCell side="left" />
        )}
      </div>

      {/* Lado Banco */}
      <div className="px-3 py-2 min-h-[60px]">
        {src.kind === "PAIR" ? (
          src.banks.length > 0 ? (
            <div className="space-y-1.5">
              {src.banks.map((b, idx) => (
                <BankCell
                  key={b.id}
                  bank={b}
                  showSeparator={idx > 0}
                  partCount={src.banks.length}
                  partIndex={idx}
                />
              ))}
            </div>
          ) : (
            <EmptyCell side="right" hint={hintForUnpairedDyna(src)} />
          )
        ) : (
          <BankCell bank={src.bank} partCount={1} partIndex={0} orphan />
        )}
      </div>
    </div>
  );
}

function hintForUnpairedDyna(row: OverviewPairRow): string {
  if (row.status === "OUT_OF_SCOPE")
    return row.outOfScopeReason ?? "Fuera de scope";
  if (row.status === "NO_MATCH") return "Sin candidatos en la ventana";
  if (row.status === "UNPROCESSED") return "Aún sin procesar matching";
  if (row.status === "REVIEW") return "Múltiples candidatos: elegir";
  if (row.status === "SUGGESTED") return "Match propuesto sin links";
  return "—";
}

function DynatechCell({
  row,
  meta,
}: {
  row: OverviewPairRow;
  meta: (typeof STATUS_META)[OverviewStatus];
}) {
  const dyn = row.dynatech;
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-text-muted">
          {formatDateTime(dyn.occurredAt)}
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${meta.cls}`}
        >
          {meta.label}
          {row.matchType && (
            <span className="ml-1 text-[9px] opacity-70">
              {shortMatchType(row.matchType)}
            </span>
          )}
        </span>
      </div>
      <div className="font-medium mt-0.5">
        {formatMoney(Number(dyn.totalAmount), dyn.currency)}
        {row.banks.length > 1 && (
          <span className="ml-1.5 text-[10px] rounded bg-brand/20 text-brand px-1 py-0.5 align-middle">
            {row.banks.length} partes
          </span>
        )}
      </div>
      <div className="text-xs text-text-muted">
        {dyn.branchExternalName ?? `#${dyn.branchExternalId}`} ·{" "}
        {dyn.cashierName || dyn.cashierUsername}
      </div>
      {dyn.customerRut && (
        <div className="text-xs">
          {dyn.customerName ?? "—"}{" "}
          <span className="text-text-muted">[{dyn.customerRut}]</span>
        </div>
      )}
      {dyn.observation && (
        <div
          className="text-[11px] text-text-muted truncate"
          title={dyn.observation}
        >
          "{dyn.observation}"
        </div>
      )}
    </div>
  );
}

function BankCell({
  bank,
  showSeparator = false,
  partCount,
  partIndex,
  orphan = false,
}: {
  bank: OverviewBank;
  showSeparator?: boolean;
  partCount: number;
  partIndex: number;
  orphan?: boolean;
}) {
  return (
    <div
      className={
        "text-sm " +
        (showSeparator ? "pt-1.5 border-t border-dashed border-border-soft" : "")
      }
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-text-muted">{formatDate(bank.postDate)}</div>
        {partCount > 1 && (
          <span className="text-[10px] text-text-muted">
            parte {partIndex + 1}/{partCount}
          </span>
        )}
        {orphan && (
          <span className="text-[10px] rounded border border-warn/40 text-warn bg-warn/10 px-1.5 py-0.5">
            Sin par Dyna
          </span>
        )}
      </div>
      <div className="font-medium mt-0.5 text-success">
        +{formatMoney(Number(bank.amount), bank.currency)}
      </div>
      <div className="text-xs text-text-muted">
        {bank.account.holderName} · {bank.account.bankName}{" "}
        {bank.account.displayNumber ?? bank.account.accountNumber}
      </div>
      {(bank.counterpartyName || bank.counterpartyRut) && (
        <div className="text-xs">
          {bank.counterpartyName ?? "—"}{" "}
          {bank.counterpartyRut && (
            <span className="text-text-muted">[{bank.counterpartyRut}]</span>
          )}
        </div>
      )}
      {bank.description && (
        <div
          className="text-[11px] text-text-muted truncate"
          title={bank.description}
        >
          {bank.description}
        </div>
      )}
    </div>
  );
}

function EmptyCell({
  side,
  hint,
}: {
  side: "left" | "right";
  hint?: string;
}) {
  return (
    <div
      className={
        "h-full flex items-center text-xs text-text-dim italic " +
        (side === "left" ? "" : "")
      }
    >
      {hint ?? (side === "left" ? "Sin venta Dynatech" : "Sin abono banco")}
    </div>
  );
}

function shortMatchType(mt: string): string {
  switch (mt) {
    case "EXACT_SAME_DAY":
      return "= día";
    case "EXACT_PM2":
      return "±2d";
    case "EXACT_PM7":
      return "±7d";
    case "EXACT_CUSTOMER_RUT":
      return "RUT cliente";
    case "SPLIT_SAME_RUT":
      return "split RUT";
    case "SPLIT":
      return "split";
    case "MANUAL":
      return "manual";
    default:
      return mt;
  }
}

/* ----------------------------- Modal orphan banco ----------------------------- */

function OrphanBankModal({
  bank,
  onClose,
}: {
  bank: OverviewBank;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Abono bancario sin par Dynatech</h2>
          <button onClick={onClose} className="btn-ghost text-sm">
            Cerrar
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <Field label="Fecha" value={formatDate(bank.postDate)} />
          <Field
            label="Cuenta"
            value={`${bank.account.holderName} · ${bank.account.bankName} ${
              bank.account.displayNumber ?? bank.account.accountNumber
            }`}
          />
          <Field
            label="Monto"
            value={`+${formatMoney(Number(bank.amount), bank.currency)}`}
            highlight
          />
          <Field
            label="Contraparte"
            value={
              bank.counterpartyName || bank.counterpartyRut
                ? `${bank.counterpartyName ?? "—"}${
                    bank.counterpartyRut ? ` · ${bank.counterpartyRut}` : ""
                  }`
                : "—"
            }
          />
          {bank.externalId && (
            <Field label="Ext ID" value={bank.externalId} mono />
          )}
          <div>
            <div className="text-xs text-text-muted mb-1">Glosa</div>
            <div className="rounded-md border border-border-soft bg-bg-soft p-2.5 text-xs">
              {bank.description || "(sin glosa)"}
            </div>
          </div>

          <div className="text-xs text-text-muted pt-2 border-t border-border-soft">
            Este abono no tiene una venta Dynatech asociada. Puede ser una
            transferencia directa que no pasó por caja, o una venta aún no
            registrada en el sistema.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div
        className={
          (mono ? "font-mono " : "") +
          (highlight ? "font-semibold text-success" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
