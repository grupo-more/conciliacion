"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ImportModal } from "./ImportModal";
import { ReassignModal } from "./ReassignModal";
import type {
  AccountsResponse,
  BankAccountDTO,
  CartolaSummary,
  MovementDTO,
  MovementsResponse,
} from "./types";
import { formatDate, formatMoney } from "@/lib/format";

export function CartolasView() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<BankAccountDTO[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<CartolaSummary | null>(null);
  const [loading, setLoading] = useState(false);

  // Filtros
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  const [search, setSearch] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);

  // Modales
  const [importOpen, setImportOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId]
  );

  async function loadAccounts() {
    const res = await fetch("/api/bank-accounts");
    if (!res.ok) return;
    const data: AccountsResponse = await res.json();
    setAccounts(data.accounts);
    if (selectedAccountId === null && data.accounts.length > 0) {
      setSelectedAccountId(data.accounts[0].id);
    }
  }

  async function loadMovements() {
    if (!selectedAccountId) return;
    setLoading(true);
    const params = new URLSearchParams({
      accountId: selectedAccountId,
      limit: "200",
      includeSummary: "true",
    });
    if (direction) params.set("direction", direction);
    if (search) params.set("q", search);
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (onlyUnmatched) params.set("onlyUnmatched", "true");

    try {
      const res = await fetch(`/api/bank-movements?${params}`);
      if (!res.ok) {
        setMovements([]);
        setTotal(0);
        setSummary(null);
        return;
      }
      const data: MovementsResponse = await res.json();
      setMovements(data.movements);
      setTotal(data.total);
      setSummary(data.summary);
      setSelectedIds(new Set());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    loadMovements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, direction, since, until, onlyUnmatched]);

  // Buscar con debounce ligero
  useEffect(() => {
    const t = setTimeout(() => {
      loadMovements();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  /** Lleva al usuario al modulo Consolidados, tab Comparar, con esta cuenta
   *  pre-seleccionada para hacer matching manual. */
  function jumpToCompareWithAccount() {
    if (!selectedAccountId) return;
    const qs = new URLSearchParams({
      tab: "compare",
      accountId: selectedAccountId,
    });
    router.push(`/dashboard/consolidados?${qs}`);
  }

  function onImported() {
    loadAccounts();
    loadMovements();
  }

  function onReassigned() {
    loadAccounts();
    loadMovements();
    setReassignOpen(false);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === movements.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(movements.map((m) => m.id)));
    }
  }

  const showCheckboxes = selectedAccount?.isUnassigned ?? false;

  // Agrupar cuentas por banco para sidebar
  const groupedAccounts = useMemo(() => {
    const map = new Map<string, BankAccountDTO[]>();
    for (const a of accounts) {
      const arr = map.get(a.bankName) ?? [];
      arr.push(a);
      map.set(a.bankName, arr);
    }
    return Array.from(map.entries()).map(([bankName, accs]) => ({
      bankName,
      accounts: accs.sort((x, y) => {
        // Sin asignar al final
        if (x.isUnassigned && !y.isUnassigned) return 1;
        if (!x.isUnassigned && y.isUnassigned) return -1;
        return x.holderName.localeCompare(y.holderName);
      }),
    }));
  }, [accounts]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-fade-in-down">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cartolas</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Movimientos de cartolas bancarias.
          </p>
        </div>
        <button onClick={() => setImportOpen(true)} className="btn-primary">
          Subir cartola
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px,1fr] gap-4">
        {/* Sidebar de cuentas */}
        <aside className="card p-3 h-fit">
          <div className="text-xs text-text-muted mb-2 px-2">Cuentas</div>
          <div className="space-y-3">
            {groupedAccounts.map(({ bankName, accounts: bankAccs }) => (
              <div key={bankName}>
                <div className="text-xs font-medium text-text-muted px-2 mb-1">
                  {bankName}
                </div>
                <div className="space-y-0.5">
                  {bankAccs.map((a) => {
                    const active = a.id === selectedAccountId;
                    const cls = active
                      ? "bg-accent/10 border border-accent/40 text-text shadow-sm"
                      : "border border-transparent hover:bg-bg-elevated text-text-muted hover:text-text";
                    return (
                      <button
                        key={a.id}
                        onClick={() => setSelectedAccountId(a.id)}
                        className={`w-full text-left rounded-md px-2 py-1.5 text-sm transition-all duration-200 ease-out ${cls}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate">
                              {a.isUnassigned ? (
                                <span className="text-warn">⚠ Sin asignar</span>
                              ) : (
                                a.holderName
                              )}
                            </div>
                            {!a.isUnassigned && (
                              <div className="text-xs text-text-muted truncate">
                                {a.displayNumber || a.accountNumber}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-text-muted shrink-0">
                            {a.movementCount}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Main: filtros + tabla */}
        <div className="space-y-3 min-w-0">
          {/* Filtros */}
          <div className="card flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="label">Buscar</label>
              <input
                className="input"
                placeholder="Glosa, contraparte, RUT…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Dirección</label>
              <select
                className="input"
                value={direction}
                onChange={(e) => setDirection(e.target.value as "" | "IN" | "OUT")}
                disabled={onlyUnmatched}
                title={onlyUnmatched ? "El filtro de no conciliados ya implica IN" : undefined}
              >
                <option value="">Todos</option>
                <option value="IN">Abonos</option>
                <option value="OUT">Cargos</option>
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

          {/* Chip filtro + atajo a Comparar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setOnlyUnmatched((v) => !v)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-all " +
                  (onlyUnmatched
                    ? "border-amber-400 bg-amber-50 text-amber-800 ring-2 ring-offset-1 ring-amber-300"
                    : "border-border-soft bg-white text-text-muted hover:bg-bg-soft")
                }
              >
                {onlyUnmatched ? "✓ " : ""}Solo sin conciliar
                {summary && (
                  <span className="ml-1 font-bold">{summary.inPending}</span>
                )}
              </button>
              {/* Leyenda */}
              <div className="hidden md:flex items-center gap-2 text-[11px] text-text-muted ml-3">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-success rounded-sm" /> Conciliado
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-warn rounded-sm" /> Sin matchear
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-text-muted/30 rounded-sm" /> Egreso (no aplica)
                </span>
              </div>
            </div>
            {summary && summary.inPending > 0 && (
              <button
                onClick={jumpToCompareWithAccount}
                className="btn-ghost text-xs"
                title="Abre la vista Comparar de Consolidados con esta cuenta pre-seleccionada"
              >
                Conciliar pendientes →
              </button>
            )}
          </div>

          {/* Acciones masivas (solo en Sin asignar) */}
          {showCheckboxes && selectedIds.size > 0 && (
            <div className="card flex items-center justify-between bg-warn/5 border-warn/40">
              <div className="text-sm">
                {selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}
              </div>
              <button
                onClick={() => setReassignOpen(true)}
                className="btn-primary"
              >
                Reasignar a cuenta…
              </button>
            </div>
          )}

          {/* Tabla */}
          <div className="card p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
                <tr>
                  {showCheckboxes && (
                    <th className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={
                          selectedIds.size === movements.length &&
                          movements.length > 0
                        }
                        onChange={toggleSelectAll}
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 text-left w-3" aria-label="estado" />
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-left">Contraparte</th>
                  <th className="px-3 py-2 text-left">Estado</th>
                  <th className="px-3 py-2 text-left">Ext ID</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td
                      colSpan={showCheckboxes ? 8 : 7}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && movements.length === 0 && (
                  <tr>
                    <td
                      colSpan={showCheckboxes ? 8 : 7}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      {onlyUnmatched
                        ? "✓ No hay abonos pendientes de conciliar en esta cuenta."
                        : "Sin movimientos."}
                    </td>
                  </tr>
                )}
                {!loading &&
                  movements.map((m) => {
                    const amount = BigInt(m.amount);
                    const isIn = m.direction === "IN";
                    const status = computeRowStatus(m);
                    return (
                      <tr
                        key={m.id}
                        className={`border-t border-border-soft/40 hover:bg-bg-elevated/40 table-row-hover ${status.rowBg}`}
                      >
                        {showCheckboxes && (
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(m.id)}
                              onChange={() => toggleSelect(m.id)}
                            />
                          </td>
                        )}
                        <td className={`p-0 ${status.borderCls}`} aria-hidden />
                        <td className="px-3 py-2 whitespace-nowrap">
                          {formatDate(m.postDate)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right whitespace-nowrap font-mono ${
                            isIn ? "text-success" : "text-danger"
                          }`}
                        >
                          {isIn ? "+" : ""}
                          {formatMoney(Number(amount), m.currency)}
                        </td>
                        <td className="px-3 py-2 max-w-md truncate" title={m.description}>
                          {m.description}
                        </td>
                        <td className="px-3 py-2">
                          <div className="truncate max-w-[200px]">
                            {m.counterpartyName || "—"}
                          </div>
                          {m.counterpartyRut && (
                            <div className="text-xs text-text-muted">
                              {m.counterpartyRut}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${status.badgeCls}`}
                            title={status.title}
                          >
                            {status.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-text-muted font-mono">
                          {m.externalId || ""}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {!loading && total > movements.length && (
            <div className="text-xs text-text-muted">
              Mostrando {movements.length} de {total} movimientos. Refina los filtros
              para ver el resto.
            </div>
          )}

          {/* Resumen al pie de la cuenta */}
          {!loading && summary && summary.total > 0 && (
            <CartolaSummaryStrip
              summary={summary}
              accountLabel={selectedAccount?.holderName ?? ""}
              onAct={jumpToCompareWithAccount}
            />
          )}
        </div>
      </div>

      {importOpen && (
        <ImportModal
          accounts={accounts}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            onImported();
          }}
        />
      )}

      {reassignOpen && selectedAccount && (
        <ReassignModal
          movementIds={Array.from(selectedIds)}
          sourceBankCode={selectedAccount.bankCode}
          accounts={accounts}
          onClose={() => setReassignOpen(false)}
          onDone={onReassigned}
        />
      )}
    </div>
  );
}

/* =============================== Helpers =============================== */

interface RowStatus {
  label: string;
  title: string;
  /** Tailwind class para el border-left (3px de color). */
  borderCls: string;
  /** Tailwind class para el badge. */
  badgeCls: string;
  /** Tailwind class para el background sutil de la fila (opcional). */
  rowBg: string;
}

function computeRowStatus(m: MovementDTO): RowStatus {
  // Egresos: no aplica conciliación
  if (m.direction === "OUT") {
    return {
      label: "Egreso",
      title: "Movimiento de salida — la conciliación no aplica.",
      borderCls: "w-[3px] bg-text-muted/20",
      badgeCls: "border-border-soft bg-bg-soft text-text-muted",
      rowBg: "",
    };
  }

  // IN sin link → pendiente
  if (!m.consolidado) {
    return {
      label: "Sin matchear",
      title: "Ingreso bancario sin contraparte en Tesorería. Requiere acción.",
      borderCls: "w-[3px] bg-warn",
      badgeCls: "border-warn/40 bg-warn/10 text-warn",
      rowBg: "bg-warn/[0.03]",
    };
  }

  // IN con link según status del Consolidado
  switch (m.consolidado.status) {
    case "AUTO_MATCHED":
      return {
        label: "Conciliado auto",
        title: "Vinculado automáticamente por el motor.",
        borderCls: "w-[3px] bg-success",
        badgeCls: "border-success/40 bg-success/10 text-success",
        rowBg: "",
      };
    case "MANUAL":
      return {
        label: "Conciliado manual",
        title: "Vinculado manualmente por un operador.",
        borderCls: "w-[3px] bg-success",
        badgeCls: "border-success/40 bg-success/10 text-success",
        rowBg: "",
      };
    case "SUGGESTED":
      return {
        label: "Sugerido",
        title: "El motor sugiere este match. Requiere confirmación.",
        borderCls: "w-[3px] bg-amber-400",
        badgeCls: "border-amber-400/50 bg-amber-50 text-amber-700",
        rowBg: "bg-amber-50/30",
      };
    case "REVIEW":
      return {
        label: "Revisar",
        title: "Vinculado pero requiere revisión humana.",
        borderCls: "w-[3px] bg-orange-400",
        badgeCls: "border-orange-400/50 bg-orange-50 text-orange-700",
        rowBg: "bg-orange-50/30",
      };
    default:
      return {
        label: m.consolidado.status,
        title: "Estado: " + m.consolidado.status,
        borderCls: "w-[3px] bg-text-muted/30",
        badgeCls: "border-border-soft bg-bg-soft text-text-muted",
        rowBg: "",
      };
  }
}

function CartolaSummaryStrip({
  summary,
  accountLabel,
  onAct,
}: {
  summary: CartolaSummary;
  accountLabel: string;
  onAct: () => void;
}) {
  const inPendingSum = BigInt(summary.inPendingSum);
  const inConciliatedSum = BigInt(summary.inConciliatedSum);
  const inSum = BigInt(summary.inSum);
  const outSum = BigInt(summary.outSum);
  const pctOk =
    summary.inTotal > 0
      ? (summary.inConciliated / summary.inTotal) * 100
      : 0;

  return (
    <div className="card mt-1">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs text-text-muted uppercase tracking-wider font-semibold">
            Resumen de la cuenta
          </div>
          <div className="text-sm font-semibold mt-0.5">{accountLabel}</div>
        </div>
        {summary.inPending > 0 && (
          <button onClick={onAct} className="btn-primary text-xs">
            Conciliar pendientes →
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <SummaryItem
          label="Abonos totales"
          value={`${summary.inTotal}`}
          sub={formatMoney(Number(inSum))}
          tone="brand"
        />
        <SummaryItem
          label="Conciliados"
          value={`${summary.inConciliated} (${pctOk.toFixed(0)}%)`}
          sub={formatMoney(Number(inConciliatedSum))}
          tone="good"
        />
        <SummaryItem
          label="Sin matchear"
          value={`${summary.inPending}`}
          sub={formatMoney(Number(inPendingSum))}
          tone={summary.inPending > 0 ? "warn" : "muted"}
        />
        <SummaryItem
          label="Cargos (egresos)"
          value={`${summary.outTotal}`}
          sub={formatMoney(Number(outSum))}
          tone="muted"
        />
      </div>

      {/* Barra visual conciliado vs pendiente */}
      {summary.inTotal > 0 && (
        <>
          <div className="mt-3 flex h-2.5 rounded-full overflow-hidden bg-bg-elevated ring-1 ring-border-soft">
            <div
              className="bg-success/80"
              style={{ width: `${pctOk}%` }}
              title={`${pctOk.toFixed(1)}% conciliado`}
            />
            <div
              className="bg-warn/70 flex-1"
              title={`${(100 - pctOk).toFixed(1)}% sin matchear`}
            />
          </div>
        </>
      )}
    </div>
  );
}

function SummaryItem({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "brand" | "good" | "warn" | "muted";
}) {
  const toneCls =
    tone === "brand"
      ? "text-brand"
      : tone === "good"
      ? "text-success"
      : tone === "warn"
      ? "text-warn"
      : "text-text-muted";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">
        {label}
      </div>
      <div className={`text-base font-bold tabular-nums ${toneCls}`}>{value}</div>
      <div className="text-xs text-text-muted font-mono mt-0.5">{sub}</div>
    </div>
  );
}
