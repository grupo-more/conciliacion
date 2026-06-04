"use client";

import { useEffect, useState } from "react";

interface Entidad {
  id: string;
  rutCanonico: string;
  rutFormatted: string;
  nombreCanonico: string;
  aliases: string[];
  rubro: number | null;
  rubroLabel: string | null;
  notas: string | null;
  active: boolean;
}

interface Rubro {
  rubro: number;
  name: string;
}

/**
 * Tab "Entidades internas" en Configuracion. CRUD de las entidades cuyos
 * RUTs/nombres identifican egresos internos en cartolas. El detector usa
 * cascada (ver lib/internos/detect.ts), asi que mientras mas variantes de
 * nombre se carguen aqui, mejor cubrimos los casos donde el banco no trae RUT.
 */
export function EntidadesInternasTab() {
  const [entidades, setEntidades] = useState<Entidad[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Entidad | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Entidad | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [eRes, rRes] = await Promise.all([
        fetch("/api/config/entidades-internas"),
        fetch("/api/rubros"),
      ]);
      if (!eRes.ok || !rRes.ok) {
        setError("No se pudo cargar.");
        return;
      }
      const e = await eRes.json();
      const r = await rRes.json();
      setEntidades(e.entidades);
      setRubros(r.rubros);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Entidades internas</h2>
          <p className="text-sm text-text-muted mt-0.5">
            RUTs y nombres considerados "propios". Sirven para identificar
            egresos internos en cartolas, incluso cuando el banco no trae el RUT
            y solo viene el nombre. Cargá las variantes de nombre que aparezcan
            efectivamente en la cartola — el matching usa palabra entera, asi
            que aliases cortos como "MG" o "ME" se matchean solo cuando son
            palabras separadas (no como substring).
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary shrink-0">
          + Nueva entidad
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
              <th className="px-4 py-2 text-left w-36">RUT</th>
              <th className="px-4 py-2 text-left">Nombre canónico</th>
              <th className="px-4 py-2 text-left">Aliases</th>
              <th className="px-4 py-2 text-left w-32">Rubro</th>
              <th className="px-4 py-2 text-center w-20">Activa</th>
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
            {!loading && entidades.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-text-muted">
                  No hay entidades aún. Creá la primera con "+ Nueva entidad".
                </td>
              </tr>
            )}
            {!loading &&
              entidades.map((e) => (
                <tr key={e.id} className="border-t border-border-soft/40 align-top">
                  <td className="px-4 py-3 font-mono">{e.rutFormatted}</td>
                  <td className="px-4 py-3 font-medium">{e.nombreCanonico}</td>
                  <td className="px-4 py-3">
                    {e.aliases.length === 0 ? (
                      <span className="text-text-dim">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {e.aliases.map((a, i) => (
                          <span
                            key={i}
                            className="inline-block rounded-full bg-bg-soft border border-border-soft text-[11px] px-2 py-0.5"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {e.rubro != null ? (
                      <span className="font-mono">
                        {e.rubro}
                        {e.rubroLabel ? ` · ${e.rubroLabel}` : ""}
                      </span>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {e.active ? (
                      <span className="inline-block rounded-full bg-emerald-100 text-emerald-800 text-[10px] px-2 py-0.5 font-bold">
                        ✓
                      </span>
                    ) : (
                      <span className="inline-block rounded-full bg-stone-100 text-stone-600 text-[10px] px-2 py-0.5 font-bold">
                        OFF
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEditing(e)}
                      className="btn-ghost text-xs mr-1"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => setConfirmDelete(e)}
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
        <EntidadFormModal
          mode="create"
          rubros={rubros}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      {editing && (
        <EntidadFormModal
          mode="edit"
          initial={editing}
          rubros={rubros}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {confirmDelete && (
        <DeleteConfirmModal
          entidad={confirmDelete}
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

/* --------------------------------- Form ------------------------------------ */

function EntidadFormModal({
  mode,
  initial,
  rubros,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Entidad;
  rubros: Rubro[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rut, setRut] = useState(initial?.rutFormatted ?? "");
  const [nombreCanonico, setNombreCanonico] = useState(
    initial?.nombreCanonico ?? "",
  );
  const [aliases, setAliases] = useState<string[]>(initial?.aliases ?? []);
  const [aliasDraft, setAliasDraft] = useState("");
  const [rubro, setRubro] = useState<string>(
    initial?.rubro != null ? String(initial.rubro) : "",
  );
  const [notas, setNotas] = useState(initial?.notas ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addAlias() {
    const v = aliasDraft.trim();
    if (!v) return;
    if (aliases.some((a) => a.toLowerCase() === v.toLowerCase())) {
      setAliasDraft("");
      return;
    }
    setAliases([...aliases, v]);
    setAliasDraft("");
  }

  function removeAlias(idx: number) {
    setAliases(aliases.filter((_, i) => i !== idx));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (rut.trim().length === 0) {
      setError("El RUT es obligatorio.");
      return;
    }
    if (nombreCanonico.trim().length === 0) {
      setError("El nombre canónico es obligatorio.");
      return;
    }

    setSubmitting(true);
    try {
      const url =
        mode === "create"
          ? "/api/config/entidades-internas"
          : `/api/config/entidades-internas/${initial!.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const body = {
        rut: rut.trim(),
        nombreCanonico: nombreCanonico.trim(),
        aliases,
        rubro: rubro ? parseInt(rubro, 10) : null,
        notas: notas.trim() || null,
        active,
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
      <div className="modal-panel max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">
            {mode === "create" ? "Nueva entidad interna" : "Editar entidad"}
          </h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">RUT</label>
              <input
                type="text"
                className="input font-mono"
                value={rut}
                onChange={(e) => setRut(e.target.value)}
                required
                placeholder="77.333.097-2"
              />
              <p className="text-xs text-text-muted mt-1">
                Se normaliza al guardar (sin puntos ni guión).
              </p>
            </div>
            <div>
              <label className="label">Rubro (opcional)</label>
              <select
                className="input"
                value={rubro}
                onChange={(e) => setRubro(e.target.value)}
              >
                <option value="">— sin rubro —</option>
                {rubros.map((r) => (
                  <option key={r.rubro} value={r.rubro}>
                    {r.rubro} · {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Nombre canónico</label>
            <input
              type="text"
              className="input"
              value={nombreCanonico}
              onChange={(e) => setNombreCanonico(e.target.value)}
              required
              maxLength={120}
              placeholder="ej: More Capital"
            />
          </div>

          <div>
            <label className="label">Aliases (variantes de nombre vistas en cartola)</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="input flex-1"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAlias();
                  }
                }}
                placeholder='ej: "More Capital Spa", "MORE CAPITAL S"'
              />
              <button
                type="button"
                onClick={addAlias}
                className="btn-ghost"
              >
                Agregar
              </button>
            </div>
            {aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {aliases.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-bg-soft border border-border-soft text-xs px-2 py-1"
                  >
                    {a}
                    <button
                      type="button"
                      onClick={() => removeAlias(i)}
                      className="text-text-muted hover:text-danger"
                      aria-label={`Quitar ${a}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-text-muted mt-1">
              Matcheo case-insensitive con bordes de palabra (ej. "ME" no
              matchea "Comercializado").
            </p>
          </div>

          <div>
            <label className="label">Notas (opcional)</label>
            <textarea
              className="input min-h-[60px]"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              maxLength={500}
              placeholder="Notas internas sobre esta entidad…"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Activa (se considera en la detección de egresos internos)</span>
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

/* ------------------------------- Delete ------------------------------------ */

function DeleteConfirmModal({
  entidad,
  onClose,
  onDeleted,
}: {
  entidad: Entidad;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/config/entidades-internas/${entidad.id}`,
        { method: "DELETE" },
      );
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
          Eliminar entidad interna
        </h2>
        <p className="text-sm text-text-muted mb-4">
          ¿Seguro que querés eliminar{" "}
          <span className="font-semibold text-text">
            {entidad.nombreCanonico}
          </span>{" "}
          ({entidad.rutFormatted})? Los egresos previamente identificados como
          internos a esta entidad dejarán de aparecer en la vista de "Egresos
          internos".
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
