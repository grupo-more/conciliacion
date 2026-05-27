"use client";

import { useEffect, useMemo, useState } from "react";

interface Account {
  id: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  displayNumber?: string | null;
  alias?: string | null;
  purpose?: string | null;
}

interface Alias {
  id: string;
  bancoString: string;
  accountId: string;
  account: Account;
  notes: string | null;
  updatedAt: string;
}

interface AliasResponse {
  aliases: Alias[];
  accounts: Account[];
  bancosSeen: string[];
  missing: string[];
}

interface Suggestion {
  bancoString: string;
  suggestion: {
    accountId: string;
    accountNumber: string;
    bankName: string;
    matches: number;
    dominance: number;
  } | null;
  reason: string;
  requiresManualConfirm?: boolean;
  accountAlreadyUsedBy?: string[];
}

export function BankAliasesTab() {
  const [data, setData] = useState<AliasResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [editing, setEditing] = useState<Alias | null>(null);
  const [creating, setCreating] = useState<string | null>(null); // bancoString para create

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/bank-aliases");
      if (!res.ok) return;
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function detectMissing() {
    setDetecting(true);
    try {
      const res = await fetch("/api/bank-aliases/auto-detect", { method: "POST" });
      if (!res.ok) return;
      const json = await res.json();
      setSuggestions(json.suggestions);
    } finally {
      setDetecting(false);
    }
  }

  async function applyAllSuggestions() {
    if (!confirm("¿Aplicar todas las sugerencias automáticas?")) return;
    setApplying(true);
    try {
      const res = await fetch("/api/bank-aliases/auto-detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply: true }),
      });
      if (res.ok) {
        const json = await res.json();
        const skippedNote =
          json.skipped > 0
            ? ` · ${json.skipped} omitidos (cuenta ya en uso por otro alias — agregalos manualmente si corresponde)`
            : "";
        alert(`${json.applied} alias creados${skippedNote}.`);
        setSuggestions([]);
        await load();
      }
    } finally {
      setApplying(false);
    }
  }

  async function deleteAlias(id: string) {
    if (!confirm("¿Eliminar este mapeo?")) return;
    const res = await fetch(`/api/bank-aliases/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  // Detectar duplicados: cuentas usadas por mas de un alias
  const aliasesByAccountId = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!data) return m;
    for (const a of data.aliases) {
      const arr = m.get(a.accountId) ?? [];
      arr.push(a.bancoString);
      m.set(a.accountId, arr);
    }
    return m;
  }, [data]);
  const duplicatedAccounts = useMemo(() => {
    const s = new Set<string>();
    for (const [accId, list] of aliasesByAccountId.entries()) {
      if (list.length > 1) s.add(accId);
    }
    return s;
  }, [aliasesByAccountId]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Mapeo de cuentas bancarias</h2>
          <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
            Cada string del campo <span className="font-mono">banco</span> que viene
            del feed de Tesorería debe estar mapeado a una cuenta bancaria del sistema.
            Este mapeo es lo que el motor de Consolidados usa para encontrar el match
            correcto. Sin mapeo, el movimiento queda en <strong>Fuera de scope</strong>.
          </p>
        </div>
        <button
          onClick={detectMissing}
          disabled={detecting}
          className="btn-ghost text-sm shrink-0"
        >
          {detecting ? "Detectando..." : "Auto-detectar faltantes"}
        </button>
      </div>

      {/* Sugerencias auto-detectadas */}
      {suggestions.length > 0 && (
        <div className="rounded-md border border-brand/30 bg-brand/5 p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-sm font-semibold">
              Sugerencias automáticas ({suggestions.filter((s) => s.suggestion).length} con sugerencia)
            </div>
            {suggestions.some((s) => s.suggestion) && (
              <button
                onClick={applyAllSuggestions}
                disabled={applying}
                className="btn-primary text-xs"
              >
                {applying ? "Aplicando..." : "Aplicar todas"}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {suggestions.map((s) => {
              const conflict = s.requiresManualConfirm;
              return (
                <div
                  key={s.bancoString}
                  className="text-sm flex justify-between items-start gap-2"
                >
                  <div className="min-w-0">
                    <span className="font-mono font-semibold">{s.bancoString}</span>
                    {s.suggestion ? (
                      <span
                        className={`ml-2 ${conflict ? "text-amber-700" : "text-emerald-700"}`}
                      >
                        → {s.suggestion.bankName} {s.suggestion.accountNumber}{" "}
                        <span className="text-xs text-text-muted">({s.reason})</span>
                      </span>
                    ) : (
                      <span className="ml-2 text-rose-700 text-xs">{s.reason}</span>
                    )}
                  </div>
                  {conflict && s.suggestion && (
                    <button
                      onClick={() => setCreating(s.bancoString)}
                      className="btn-ghost text-xs whitespace-nowrap"
                    >
                      Crear manualmente
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {suggestions.some((s) => s.requiresManualConfirm) && (
            <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2">
              ⚠ Las sugerencias en ámbar apuntan a cuentas que <strong>ya están mapeadas</strong>{" "}
              por otro alias. <em>No se aplican automáticamente</em> — si querés
              tenerlas duplicadas (caso raro), creálas a mano con "Crear manualmente".
            </div>
          )}
        </div>
      )}

      {/* Faltantes */}
      {data && data.missing.length > 0 && (
        <div className="rounded-md border border-warn/40 bg-warn/10 p-4">
          <div className="text-sm font-semibold text-warn">
            {data.missing.length} string{data.missing.length === 1 ? "" : "s"} sin mapeo:
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.missing.map((b) => (
              <button
                key={b}
                onClick={() => setCreating(b)}
                className="rounded-full bg-white border border-warn/40 text-warn px-3 py-1 text-xs font-mono hover:bg-warn/20"
              >
                + {b}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Tabla actual */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-4 py-2 text-left">String "banco"</th>
              <th className="px-4 py-2 text-left">→ Cuenta bancaria</th>
              <th className="px-4 py-2 text-left">Notas</th>
              <th className="px-4 py-2 text-right w-40">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-text-muted">Cargando…</td></tr>
            )}
            {!loading && data?.aliases.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-text-muted">
                Sin mapeos. Usa "Auto-detectar faltantes" para empezar.
              </td></tr>
            )}
            {!loading && data?.aliases.map((a) => {
              const isDuplicated = duplicatedAccounts.has(a.accountId);
              const otherAliases = isDuplicated
                ? (aliasesByAccountId.get(a.accountId) ?? []).filter(
                    (s) => s !== a.bancoString
                  )
                : [];
              return (
              <tr
                key={a.id}
                className={
                  "border-t border-border-soft/40 " +
                  (isDuplicated ? "bg-amber-50/40" : "")
                }
              >
                <td className="px-4 py-3 font-mono font-semibold">{a.bancoString}</td>
                <td className="px-4 py-3">
                  <div className="font-semibold flex items-center gap-2 flex-wrap">
                    {a.account.bankName}
                    {isDuplicated && (
                      <span
                        className="inline-block text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-300 px-1.5 py-0.5 rounded"
                        title={`También usada por: ${otherAliases.join(", ")}`}
                      >
                        ⚠ Compartida
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-text-muted">
                    {a.account.accountNumber}
                    {a.account.alias && ` · ${a.account.alias}`}
                  </div>
                  {isDuplicated && (
                    <div className="text-[11px] text-amber-700 mt-0.5">
                      También usada por:{" "}
                      <span className="font-mono">{otherAliases.join(", ")}</span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-text-muted text-xs">
                  {a.notes || <span className="text-text-dim">—</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => setEditing(a)} className="btn-ghost text-xs mr-1">
                    Editar
                  </button>
                  <button
                    onClick={() => deleteAlias(a.id)}
                    className="btn-ghost text-xs text-danger hover:bg-danger/10"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && data && (
        <AliasFormModal
          mode="edit"
          initial={editing}
          accounts={data.accounts}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {creating && data && (
        <AliasFormModal
          mode="create"
          initialBancoString={creating}
          accounts={data.accounts}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); load(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------ Modal de form ------------------------------ */

function AliasFormModal({
  mode,
  initial,
  initialBancoString,
  accounts,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Alias;
  initialBancoString?: string;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [bancoString, setBancoString] = useState(initial?.bancoString ?? initialBancoString ?? "");
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accountId) {
      setError("Seleccioná una cuenta.");
      return;
    }
    if (mode === "create" && !bancoString.trim()) {
      setError("Falta el string de banco.");
      return;
    }
    setSubmitting(true);
    try {
      const url = mode === "create" ? "/api/bank-aliases" : `/api/bank-aliases/${initial!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const body = mode === "create"
        ? { bancoString: bancoString.trim(), accountId, notes: notes.trim() || null }
        : { accountId, notes: notes.trim() || null };
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Error al guardar.");
        return;
      }
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">
            {mode === "create" ? "Nuevo mapeo" : "Editar mapeo"}
          </h2>
          <button onClick={onClose} className="btn-ghost text-sm">×</button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">String banco (de Tesorería)</label>
            <input
              type="text"
              className="input font-mono"
              value={bancoString}
              onChange={(e) => setBancoString(e.target.value)}
              disabled={mode === "edit"}
              placeholder="ej: Santander ME"
              required
            />
            {mode === "edit" && (
              <p className="text-xs text-text-muted mt-1">El string no se puede modificar (eliminá y crea uno nuevo).</p>
            )}
          </div>
          <div>
            <label className="label">Cuenta bancaria</label>
            <select
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              required
            >
              <option value="">— Seleccioná —</option>
              {accounts
                .filter((a) => !a.accountNumber.startsWith("_UNASSIGNED_"))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.bankName} · {a.accountNumber}
                    {a.alias && ` (${a.alias})`}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="label">Notas (opcional)</label>
            <textarea
              className="input min-h-[60px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-2.5 text-sm">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? "Guardando…" : mode === "create" ? "Crear" : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
