"use client";

import { useEffect, useMemo, useState } from "react";

interface Account {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber: string | null;
  holderName: string;
  alias: string | null;
  accountingRubro: number | null;
  isUnassigned: boolean;
  movementCount: number;
}

interface Rubro {
  rubro: number;
  name: string;
  isDifference: boolean;
}

export function BankAccountsTab() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [accRes, rubRes] = await Promise.all([
        fetch("/api/bank-accounts"),
        fetch("/api/rubros"),
      ]);
      if (accRes.ok) {
        const d = await accRes.json();
        setAccounts(
          (d.accounts as Account[]).filter((a) => !a.isUnassigned)
        );
      }
      if (rubRes.ok) {
        const d = await rubRes.json();
        setRubros(d.rubros as Rubro[]);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Rubros válidos para banco: NO los de diferencia.
  const bankRubros = useMemo(
    () => rubros.filter((r) => !r.isDifference),
    [rubros]
  );
  const labelByRubro = useMemo(
    () => new Map(rubros.map((r) => [r.rubro, r.name])),
    [rubros]
  );

  async function updateRubro(id: string, raw: string) {
    setError(null);
    setSavingId(id);
    try {
      const value = raw === "" ? null : Number(raw);
      const res = await fetch(`/api/bank-accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountingRubro: value }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error || "No se pudo guardar.");
        return;
      }
      setAccounts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, accountingRubro: value } : a))
      );
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Cuentas bancarias</h2>
        <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
          Asigná un <strong>rubro contable</strong> a cada cuenta. En el módulo
          OK, cuando hagas un match <strong>manual</strong>, el rubro de la
          cuenta predominará sobre el que vino de la API de Tesorería (evita el
          problema cuando el operador tipea mal el banco al cargar).
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-3 text-sm">
          {error}
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-4 py-2 text-left">Banco</th>
              <th className="px-4 py-2 text-left">Cuenta</th>
              <th className="px-4 py-2 text-left">Titular</th>
              <th className="px-4 py-2 text-right">Movs</th>
              <th className="px-4 py-2 text-left w-72">Rubro contable</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-text-muted">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-text-muted">
                  No hay cuentas registradas.
                </td>
              </tr>
            )}
            {!loading &&
              accounts.map((a) => {
                const currentLabel =
                  a.accountingRubro !== null
                    ? labelByRubro.get(a.accountingRubro)
                    : null;
                return (
                  <tr key={a.id} className="border-t border-border-soft/40">
                    <td className="px-4 py-3 font-semibold">{a.bankName}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {a.displayNumber || a.accountNumber}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {a.holderName}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {a.movementCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <select
                          className="input flex-1"
                          value={a.accountingRubro ?? ""}
                          onChange={(e) => updateRubro(a.id, e.target.value)}
                          disabled={savingId === a.id}
                        >
                          <option value="">— Sin asignar —</option>
                          {bankRubros.map((r) => (
                            <option key={r.rubro} value={r.rubro}>
                              {r.rubro} · {r.name}
                            </option>
                          ))}
                        </select>
                        {savingId === a.id && (
                          <span className="text-xs text-text-muted">
                            guardando…
                          </span>
                        )}
                        {a.accountingRubro !== null && !currentLabel && (
                          <span
                            className="text-[10px] text-amber-700"
                            title="Este rubro no existe en el catálogo"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
