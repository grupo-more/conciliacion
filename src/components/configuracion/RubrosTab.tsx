"use client";

import { useEffect, useState } from "react";

interface Rubro {
  rubro: number;
  name: string;
  description: string | null;
  isDifference: boolean;
  accountId: string | null;
  accountLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CuentaOption {
  id: string;
  label: string;
}

export function RubrosTab() {
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [cuentas, setCuentas] = useState<CuentaOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Rubro | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Rubro | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rubros");
      if (!res.ok) {
        setError("No se pudieron cargar los rubros.");
        return;
      }
      const data = await res.json();
      setRubros(data.rubros);
    } finally {
      setLoading(false);
    }
  }

  async function loadCuentas() {
    const res = await fetch("/api/bank-accounts");
    if (!res.ok) return;
    const data = await res.json();
    setCuentas(
      (data.accounts ?? [])
        .filter((a: { isUnassigned?: boolean }) => !a.isUnassigned)
        .map((a: { id: string; bankName: string; holderName: string; displayNumber: string | null; accountNumber: string }) => ({
          id: a.id,
          label: `${a.bankName} ${a.holderName} · ${a.displayNumber || a.accountNumber}`,
        })),
    );
  }

  useEffect(() => {
    load();
    loadCuentas();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Rubros contables</h2>
          <p className="text-sm text-text-muted mt-0.5">
            Etiquetas para los códigos de rubro que entrega la API de Dynatech.
            El nombre que pongas aquí se muestra en los filtros y detalles de movimientos.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary shrink-0">
          + Nuevo rubro
        </button>
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
              <th className="px-4 py-2 text-left w-24">Código</th>
              <th className="px-4 py-2 text-left">Nombre</th>
              <th className="px-4 py-2 text-left">Cuenta banco</th>
              <th className="px-4 py-2 text-left">Descripción</th>
              <th className="px-4 py-2 text-center w-32">Diferencias</th>
              <th className="px-4 py-2 text-right w-32">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && rubros.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                  No hay rubros aún. Crea el primero con "+ Nuevo rubro".
                </td>
              </tr>
            )}
            {!loading &&
              rubros.map((r) => (
                <tr key={r.rubro} className="border-t border-border-soft/40">
                  <td className="px-4 py-3 font-mono font-semibold">{r.rubro}</td>
                  <td className="px-4 py-3">{r.name}</td>
                  <td className="px-4 py-3 text-text-muted">
                    {r.accountLabel ? (
                      <span className="inline-block rounded-full bg-brand/10 text-brand text-[11px] px-2 py-0.5">
                        {r.accountLabel}
                      </span>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {r.description || <span className="text-text-dim">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {r.isDifference ? (
                      <span className="inline-block rounded-full bg-amber-100 text-amber-800 text-[10px] px-2 py-0.5 font-bold">
                        ✓ DIF
                      </span>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(r)}
                      className="btn-ghost text-xs mr-1"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => setConfirmDelete(r)}
                      className="btn-ghost text-xs text-danger hover:bg-danger/10"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <RubroFormModal
          mode="create"
          cuentas={cuentas}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editing && (
        <RubroFormModal
          mode="edit"
          initial={editing}
          cuentas={cuentas}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {confirmDelete && (
        <DeleteConfirmModal
          rubro={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => {
            setConfirmDelete(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------- Form modal ---------------------------------- */

function RubroFormModal({
  mode,
  initial,
  cuentas,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Rubro;
  cuentas: CuentaOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rubro, setRubro] = useState(initial?.rubro.toString() ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [isDifference, setIsDifference] = useState(initial?.isDifference ?? false);
  const [accountId, setAccountId] = useState<string>(initial?.accountId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const code = parseInt(rubro, 10);
    if (mode === "create" && (Number.isNaN(code) || code <= 0)) {
      setError("El código debe ser un número entero positivo.");
      return;
    }
    if (name.trim().length === 0) {
      setError("El nombre es obligatorio.");
      return;
    }

    setSubmitting(true);
    try {
      const url = mode === "create" ? "/api/rubros" : `/api/rubros/${initial!.rubro}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const body =
        mode === "create"
          ? {
              rubro: code,
              name: name.trim(),
              description: description.trim() || null,
              isDifference,
              accountId: accountId || null,
            }
          : {
              name: name.trim(),
              description: description.trim() || null,
              isDifference,
              accountId: accountId || null,
            };

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "No se pudo guardar.");
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
            {mode === "create" ? "Nuevo rubro" : `Editar rubro ${initial!.rubro}`}
          </h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Código</label>
            <input
              type="number"
              className="input"
              value={rubro}
              onChange={(e) => setRubro(e.target.value)}
              required
              min={1}
              disabled={mode === "edit"}
              placeholder="ej: 200"
            />
            {mode === "edit" && (
              <p className="text-xs text-text-muted mt-1">
                El código no se puede modificar.
              </p>
            )}
          </div>
          <div>
            <label className="label">Nombre</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              placeholder="ej: Tesorería"
            />
          </div>
          <div>
            <label className="label">Cuenta banco (opcional)</label>
            <select
              className="input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">— Sin cuenta (no es rubro de banco) —</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-muted mt-1">
              Si este rubro corresponde a una cuenta bancaria, enlazala acá. Se usa
              para poner el rubro del banco en los asientos (Asientos manuales /
              Traspasos internos) sin adivinar por nombre.
            </p>
          </div>
          <div>
            <label className="label">Descripción (opcional)</label>
            <textarea
              className="input min-h-[80px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder="Notas internas sobre este rubro…"
            />
          </div>
          <label className="flex items-start gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isDifference}
              onChange={(e) => setIsDifference(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Usar para diferencias</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Habilita este rubro como destino de la diferencia en matches manuales
                (ej. "Excedentes", "Faltantes"). Solo aparece en el form de ajuste.
              </span>
            </span>
          </label>

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-2.5 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancelar
            </button>
            <button type="submit" disabled={submitting} className="btn-primary">
              {submitting ? "Guardando…" : mode === "create" ? "Crear" : "Guardar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ----------------------------- Delete modal -------------------------------- */

function DeleteConfirmModal({
  rubro,
  onClose,
  onDeleted,
}: {
  rubro: Rubro;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rubros/${rubro.rubro}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "No se pudo eliminar.");
        return;
      }
      onDeleted();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold tracking-tight mb-2">
          Eliminar rubro
        </h2>
        <p className="text-sm text-text-muted mb-4">
          ¿Seguro que quieres eliminar el rubro{" "}
          <span className="font-mono font-semibold text-text">{rubro.rubro}</span>{" "}
          ({rubro.name})? Los movimientos Dynatech que lo usan seguirán mostrándose,
          pero sin etiqueta.
        </p>

        {error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-2.5 text-sm mb-3">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancelar
          </button>
          <button
            onClick={doDelete}
            disabled={submitting}
            className="btn-primary bg-danger hover:bg-danger/90"
          >
            {submitting ? "Eliminando…" : "Eliminar"}
          </button>
        </div>
      </div>
    </div>
  );
}
