"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ImportModal } from "./ImportModal";
import { TransbankImportModal } from "./TransbankImportModal";
import { TransbankSalesView } from "./TransbankSalesView";
import { ReassignModal } from "./ReassignModal";
import { DuplicatesModal } from "./DuplicatesModal";
import type {
  AccountsResponse,
  BankAccountDTO,
  CartolaSummary,
  MovementDTO,
  MovementsResponse,
} from "./types";
import { formatDate, formatMoney } from "@/lib/format";
import { usePermisos } from "@/lib/use-permisos";

/** Sentinel para "Vista general" (todas las cuentas). */
const ALL_ACCOUNTS = "__all__";
/** Sentinel para la vista de Abonos Transbank (settlement importado). */
const TRANSBANK_VIEW = "__transbank__";

export function CartolasView() {
  const router = useRouter();
  const { can } = usePermisos();
  const [accounts, setAccounts] = useState<BankAccountDTO[]>([]);
  // null = aun no se cargaron las cuentas
  // ALL_ACCOUNTS = vista general (todas)
  // UUID = una cuenta especifica
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
  // Vista "Movimientos descartados": muestra solo los descartados y habilita restaurar.
  const [descartadosView, setDescartadosView] = useState(false);
  const [descartando, setDescartando] = useState(false);

  // Modales
  const [importOpen, setImportOpen] = useState(false);
  const [transbankOpen, setTransbankOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const isGlobalView = selectedAccountId === ALL_ACCOUNTS;
  const isTransbankView = selectedAccountId === TRANSBANK_VIEW;
  const selectedAccount = useMemo(
    () =>
      isGlobalView
        ? null
        : accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId, isGlobalView]
  );

  async function loadAccounts() {
    const res = await fetch("/api/bank-accounts");
    if (!res.ok) return;
    const data: AccountsResponse = await res.json();
    setAccounts(data.accounts);
    // Default: vista general
    if (selectedAccountId === null) {
      setSelectedAccountId(ALL_ACCOUNTS);
    }
  }

  async function loadMovements() {
    if (selectedAccountId === null || selectedAccountId === TRANSBANK_VIEW) return;
    setLoading(true);
    const params = new URLSearchParams({
      limit: "200",
      includeSummary: "true",
    });
    if (!isGlobalView) params.set("accountId", selectedAccountId);
    if (direction) params.set("direction", direction);
    if (search) params.set("q", search);
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (onlyUnmatched) params.set("onlyUnmatched", "true");
    if (descartadosView) params.set("descartados", "only");

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
  }, [selectedAccountId, direction, since, until, onlyUnmatched, descartadosView]);

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

  // Checkboxes disponibles en cualquier vista de movimientos (para descartar /
  // restaurar / reasignar). Reasignar sigue restringido a "Sin asignar".
  const showCheckboxes =
    selectedAccountId !== null && !isTransbankView;
  const canReassign = (selectedAccount?.isUnassigned ?? false) && !descartadosView;

  async function descartarSelected() {
    if (selectedIds.size === 0) return;
    if (
      !confirm(
        `¿Enviar ${selectedIds.size} movimiento(s) a "Movimientos descartados"? ` +
          `Quedan fuera de conciliación y no se reinsertan al reimportar la cartola.`,
      )
    )
      return;
    const razon = window.prompt("Motivo (opcional):", "") || null;
    setDescartando(true);
    try {
      const res = await fetch("/api/bank-movements/descartar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movementIds: Array.from(selectedIds), razon }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        alert(j?.error ?? "No se pudieron descartar.");
        return;
      }
      if (j?.mensaje) alert(j.mensaje);
      await loadMovements();
    } finally {
      setDescartando(false);
    }
  }

  async function restaurarSelected() {
    if (selectedIds.size === 0) return;
    setDescartando(true);
    try {
      const res = await fetch("/api/bank-movements/descartar", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movementIds: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        alert("No se pudieron restaurar.");
        return;
      }
      await loadMovements();
    } finally {
      setDescartando(false);
    }
  }

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
        <div className="flex items-center gap-2">
          {can("depurar") && (
            <button
              onClick={() => setDuplicatesOpen(true)}
              className="btn-ghost text-sm"
              title="Buscar y limpiar movimientos duplicados"
            >
              Detectar duplicados
            </button>
          )}
          {can("importar") && (
            <>
              <button
                onClick={() => setTransbankOpen(true)}
                className="btn-ghost text-sm"
                title="Subir el reporte 'Abonos por día' de Transbank (.xls)"
              >
                Subir abonos Transbank
              </button>
              <button onClick={() => setImportOpen(true)} className="btn-primary">
                Subir cartola
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px,1fr] gap-4">
        {/* Sidebar de cuentas */}
        <aside className="card p-3 h-fit">
          {/* Vista general (todas las cuentas) */}
          <button
            onClick={() => setSelectedAccountId(ALL_ACCOUNTS)}
            className={`w-full text-left rounded-md px-2 py-2 text-sm transition-all duration-200 mb-3 ${
              isGlobalView
                ? "bg-brand/10 border border-brand/40 text-brand shadow-sm"
                : "border border-transparent hover:bg-bg-elevated text-text-muted hover:text-text"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold flex items-center gap-1.5">
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
                Vista general
              </div>
              <div className="text-xs text-text-muted shrink-0">
                {accounts.reduce((s, a) => s + a.movementCount, 0)}
              </div>
            </div>
            <div className="text-xs text-text-muted mt-0.5 ml-5">
              Todas las cuentas
            </div>
          </button>

          {/* Abonos Transbank (settlement importado) */}
          <button
            onClick={() => setSelectedAccountId(TRANSBANK_VIEW)}
            className={`w-full text-left rounded-md px-2 py-2 text-sm transition-all duration-200 mb-3 ${
              isTransbankView
                ? "bg-sky-500/10 border border-sky-400/40 text-sky-700 shadow-sm"
                : "border border-transparent hover:bg-bg-elevated text-text-muted hover:text-text"
            }`}
          >
            <div className="font-semibold flex items-center gap-1.5">
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <line x1="2" y1="10" x2="22" y2="10" />
              </svg>
              Abonos Transbank
            </div>
            <div className="text-xs text-text-muted mt-0.5 ml-5">
              Liquidaciones importadas (.xls)
            </div>
          </button>

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

        {/* Main: vista de Abonos Transbank, o filtros + tabla de cartola */}
        {isTransbankView ? (
          <TransbankSalesView />
        ) : (
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
                title="Ingresos y egresos sin conciliar (usá el selector Dirección para filtrar abonos/cargos)"
              >
                {onlyUnmatched ? "✓ " : ""}Solo sin conciliar
                {/* Con el filtro activo: cantidad real mostrada (ambas direcciones).
                    Sin el filtro: preview de ingresos pendientes. */}
                {onlyUnmatched ? (
                  <span className="ml-1 font-bold">{total}</span>
                ) : summary ? (
                  <span className="ml-1 font-bold">{summary.inPending}</span>
                ) : null}
              </button>
              <button
                onClick={() =>
                  setDescartadosView((v) => {
                    const next = !v;
                    if (next) setOnlyUnmatched(false);
                    return next;
                  })
                }
                className={
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-all " +
                  (descartadosView
                    ? "border-rose-400 bg-rose-50 text-rose-800 ring-2 ring-offset-1 ring-rose-300"
                    : "border-border-soft bg-white text-text-muted hover:bg-bg-soft")
                }
                title="Movimientos que no corresponden al sistema (fuera de conciliación)"
              >
                {descartadosView ? "✓ " : ""}Movimientos descartados
              </button>
              {/* Leyenda */}
              <div className="hidden md:flex items-center gap-2 text-[11px] text-text-muted ml-3">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-success rounded-sm" /> Conciliado
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-warn rounded-sm" /> Sin conciliar
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-sky-500 rounded-sm" /> Abono Transbank
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-violet-500 rounded-sm" /> Dif menor
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-rose-500 rounded-sm" /> Descartado
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-1 h-3 bg-text-muted/20 rounded-sm" /> No relevante
                </span>
              </div>
            </div>
            {summary && summary.inPending > 0 && !isGlobalView && (
              <button
                onClick={jumpToCompareWithAccount}
                className="btn-ghost text-xs"
                title="Abre la vista Comparar de Consolidados con esta cuenta pre-seleccionada"
              >
                Conciliar pendientes →
              </button>
            )}
            {summary && summary.inPending > 0 && isGlobalView && (
              <button
                onClick={() => router.push("/dashboard/consolidados?tab=compare")}
                className="btn-ghost text-xs"
                title="Abre la vista Comparar para conciliar pendientes en todas las cuentas"
              >
                Conciliar todas las pendientes →
              </button>
            )}
          </div>

          {/* Acciones masivas sobre la selección */}
          {showCheckboxes && selectedIds.size > 0 && (
            <div className="card flex items-center justify-between bg-warn/5 border-warn/40">
              <div className="text-sm">
                {selectedIds.size} seleccionado{selectedIds.size === 1 ? "" : "s"}
              </div>
              <div className="flex items-center gap-2">
                {canReassign && (
                  <button onClick={() => setReassignOpen(true)} className="btn-ghost">
                    Reasignar a cuenta…
                  </button>
                )}
                {descartadosView ? (
                  <button
                    onClick={restaurarSelected}
                    disabled={descartando}
                    className="btn-primary"
                  >
                    {descartando ? "Restaurando…" : "Restaurar"}
                  </button>
                ) : (
                  <button
                    onClick={descartarSelected}
                    disabled={descartando}
                    className="rounded-md bg-rose-600 text-white text-sm font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                  >
                    {descartando ? "Enviando…" : "Enviar a descartados"}
                  </button>
                )}
              </div>
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
                  {isGlobalView && (
                    <th className="px-3 py-2 text-left">Cuenta</th>
                  )}
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
                      colSpan={(showCheckboxes ? 8 : 7) + (isGlobalView ? 1 : 0)}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && movements.length === 0 && (
                  <tr>
                    <td
                      colSpan={(showCheckboxes ? 8 : 7) + (isGlobalView ? 1 : 0)}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      {onlyUnmatched
                        ? "✓ No hay abonos pendientes de conciliar."
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
                        {isGlobalView && (
                          <td className="px-3 py-2 whitespace-nowrap text-xs">
                            <div className="font-medium">{m.account.bankName}</div>
                            <div className="text-text-muted font-mono">
                              {m.account.displayNumber || m.account.accountNumber}
                            </div>
                          </td>
                        )}
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

          {/* Resumen al pie (de cuenta o global) */}
          {!loading && summary && summary.total > 0 && (
            <CartolaSummaryStrip
              summary={summary}
              accountLabel={
                isGlobalView
                  ? "Vista general · todas las cuentas"
                  : selectedAccount?.holderName ?? ""
              }
              onAct={
                isGlobalView
                  ? () => router.push("/dashboard/consolidados?tab=compare")
                  : jumpToCompareWithAccount
              }
            />
          )}
        </div>
        )}
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

      {transbankOpen && (
        <TransbankImportModal
          onClose={() => setTransbankOpen(false)}
          onImported={() => {
            // El import de Transbank no toca BankMovement; no recargamos cartolas.
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

      {duplicatesOpen && (
        <DuplicatesModal
          onClose={() => {
            setDuplicatesOpen(false);
            // Recargar movimientos por si se fusionaron items
            loadMovements();
            loadAccounts();
          }}
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
  // Descartado explícitamente: no corresponde al sistema, fuera de conciliación.
  if (m.descartadoAt) {
    return {
      label: "Descartado",
      title:
        "Movimiento enviado a 'Movimientos descartados': no corresponde al sistema, no concilia ni cuenta como pendiente.",
      borderCls: "w-[3px] bg-rose-500",
      badgeCls: "border-rose-400/40 bg-rose-50 text-rose-700",
      rowBg: "bg-rose-50/20",
    };
  }

  // Cuenta de uso parcial: solo sus traspasos internos importan (viven en
  // Traspasos internos). Todo lo demás es "No relevante" — no cuenta como
  // sin conciliar en ningún lado.
  if (m.noRelevante) {
    return {
      label: "No relevante",
      title:
        "Cuenta de uso parcial: solo sus traspasos internos son relevantes (ver Consolidados → Traspasos internos). El resto no se concilia.",
      borderCls: "w-[3px] bg-text-muted/20",
      badgeCls: "border-border-soft bg-bg-soft text-text-muted",
      rowBg: "",
    };
  }

  // ── Conciliado por el motor (Consolidados) — cualquier dirección ──
  if (m.consolidado) {
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

  // ── Egreso conciliado contra Dynatech (Consolidados → Egresos a terceros) ──
  if (m.egresoConciliado) {
    return {
      label: "Conciliado",
      title: "Egreso conciliado contra Dynatech (Consolidados → Egresos a terceros).",
      borderCls: "w-[3px] bg-success",
      badgeCls: "border-success/40 bg-success/10 text-success",
      rowBg: "",
    };
  }

  // ── Asiento manual generado ──
  if (m.asientoManual) {
    return {
      label: "Asiento manual",
      title: "Tiene un asiento manual generado (Consolidados → Asientos manuales).",
      borderCls: "w-[3px] bg-success",
      badgeCls: "border-success/40 bg-success/10 text-success",
      rowBg: "",
    };
  }

  // ── Egreso (cargo/OUT) sin resolver → pendiente, requiere acción ──
  if (m.direction === "OUT") {
    return {
      label: "Sin conciliar",
      title:
        "Cargo (egreso) sin conciliar. Se concilia en Consolidados → Egresos a terceros (o traspaso interno).",
      borderCls: "w-[3px] bg-warn",
      badgeCls: "border-warn/40 bg-warn/10 text-warn",
      rowBg: "bg-warn/[0.03]",
    };
  }

  // ── Ingreso (IN) sin resolver → Abono Transbank / Dif menor / Sin matchear ──
  if (m.transbank) {
    return {
      label: "Abono Transbank",
      title:
        "Liquidación de Transbank. Tiene asiento propio en Consolidados → tab Abono Transbank.",
      borderCls: "w-[3px] bg-sky-500",
      badgeCls: "border-sky-400/40 bg-sky-50 text-sky-700",
      rowBg: "bg-sky-50/30",
    };
  }
  if (m.difMenor) {
    return {
      label: "Dif menor",
      title:
        "Transferencia chica (bajo el umbral configurado). Tiene asiento propio en Consolidados → tab Dif menor a 100.",
      borderCls: "w-[3px] bg-violet-500",
      badgeCls: "border-violet-400/40 bg-violet-50 text-violet-700",
      rowBg: "bg-violet-50/30",
    };
  }
  return {
    label: "Sin matchear",
    title: "Ingreso bancario sin contraparte en Tesorería. Requiere acción.",
    borderCls: "w-[3px] bg-warn",
    badgeCls: "border-warn/40 bg-warn/10 text-warn",
    rowBg: "bg-warn/[0.03]",
  };
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

      <div className="mt-3 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
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
          label="Abono Transbank"
          value={`${summary.inTransbank}`}
          sub={formatMoney(Number(BigInt(summary.inTransbankSum)))}
          tone={summary.inTransbank > 0 ? "info" : "muted"}
        />
        <SummaryItem
          label="Dif menor"
          value={`${summary.inDifMenor}`}
          sub={formatMoney(Number(BigInt(summary.inDifMenorSum)))}
          tone={summary.inDifMenor > 0 ? "accent" : "muted"}
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
  tone: "brand" | "good" | "warn" | "info" | "accent" | "muted";
}) {
  const toneCls =
    tone === "brand"
      ? "text-brand"
      : tone === "good"
      ? "text-success"
      : tone === "warn"
      ? "text-warn"
      : tone === "info"
      ? "text-sky-600"
      : tone === "accent"
      ? "text-violet-600"
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
