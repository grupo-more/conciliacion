"use client";

import { useEffect, useMemo, useState } from "react";
import { ImportModal } from "./ImportModal";
import { ReassignModal } from "./ReassignModal";
import type {
  AccountsResponse,
  BankAccountDTO,
  MovementDTO,
  MovementsResponse,
} from "./types";
import { formatDate, formatMoney } from "@/lib/format";

export function CartolasView() {
  const [accounts, setAccounts] = useState<BankAccountDTO[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [movements, setMovements] = useState<MovementDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Filtros
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  const [search, setSearch] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

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
    });
    if (direction) params.set("direction", direction);
    if (search) params.set("q", search);
    if (since) params.set("since", since);
    if (until) params.set("until", until);

    try {
      const res = await fetch(`/api/bank-movements?${params}`);
      if (!res.ok) {
        setMovements([]);
        setTotal(0);
        return;
      }
      const data: MovementsResponse = await res.json();
      setMovements(data.movements);
      setTotal(data.total);
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
  }, [selectedAccountId, direction, since, until]);

  // Buscar con debounce ligero
  useEffect(() => {
    const t = setTimeout(() => {
      loadMovements();
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

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
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-left">Contraparte</th>
                  <th className="px-3 py-2 text-left">Ext ID</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td
                      colSpan={showCheckboxes ? 6 : 5}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && movements.length === 0 && (
                  <tr>
                    <td
                      colSpan={showCheckboxes ? 6 : 5}
                      className="px-3 py-6 text-center text-text-muted"
                    >
                      Sin movimientos.
                    </td>
                  </tr>
                )}
                {!loading &&
                  movements.map((m) => {
                    const amount = BigInt(m.amount);
                    const isIn = m.direction === "IN";
                    return (
                      <tr
                        key={m.id}
                        className="border-t border-border-soft/40 hover:bg-bg-elevated/40 table-row-hover"
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
