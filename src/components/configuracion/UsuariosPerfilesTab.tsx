"use client";

import { useCallback, useEffect, useState } from "react";
import { MODULO_LABELS, ACCION_LABELS, type Permisos } from "@/lib/perms-shared";

/**
 * Configuración → Usuarios y perfiles.
 *  - Usuarios: crear, asignar perfil, activar/desactivar, resetear contraseña.
 *  - Perfiles: editar las VARIABLES (módulos visibles + acciones) de cada perfil,
 *    crear perfiles nuevos y eliminar los que no tengan usuarios.
 * El perfil Admin es de acceso total: no se edita ni se elimina.
 */

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  active: boolean;
  perfilId: string | null;
  perfilNombre: string | null;
  esAdmin: boolean;
}
interface PerfilRow {
  id: string;
  nombre: string;
  esAdmin: boolean;
  permisos: Permisos;
  userCount: number;
}

export function UsuariosPerfilesTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [perfiles, setPerfiles] = useState<PerfilRow[]>([]);
  const [modulos, setModulos] = useState<string[]>([]);
  const [acciones, setAcciones] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, p] = await Promise.all([
        fetch("/api/admin/usuarios").then((r) => (r.ok ? r.json() : { users: [] })),
        fetch("/api/admin/perfiles").then((r) => (r.ok ? r.json() : { perfiles: [], modulos: [], acciones: [] })),
      ]);
      setUsers(u.users ?? []);
      setPerfiles(p.perfiles ?? []);
      setModulos(p.modulos ?? []);
      setAcciones(p.acciones ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function flash(kind: "ok" | "err", msg: string) {
    setBanner({ kind, msg });
    if (kind === "ok") setTimeout(() => setBanner(null), 4000);
  }

  async function patchUser(id: string, data: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) flash("err", j.error || "Error al actualizar el usuario");
      else {
        flash("ok", okMsg);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      {banner && (
        <div
          className={`rounded-lg px-3 py-2 text-sm border ${
            banner.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : "bg-rose-50 text-rose-800 border-rose-200"
          }`}
        >
          {banner.msg}
          <button onClick={() => setBanner(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted py-8 text-center">Cargando…</div>
      ) : (
        <>
          <UsuariosSection
            users={users}
            perfiles={perfiles}
            busy={busy}
            onPatch={patchUser}
            onCreated={() => {
              flash("ok", "Usuario creado.");
              load();
            }}
            onError={(m) => flash("err", m)}
          />
          <PerfilesSection
            perfiles={perfiles}
            modulos={modulos}
            acciones={acciones}
            onChanged={(m) => {
              flash("ok", m);
              load();
            }}
            onError={(m) => flash("err", m)}
          />
        </>
      )}
    </div>
  );
}

/* ============================== Usuarios ============================== */

function UsuariosSection({
  users,
  perfiles,
  busy,
  onPatch,
  onCreated,
  onError,
}: {
  users: UserRow[];
  perfiles: PerfilRow[];
  busy: boolean;
  onPatch: (id: string, data: Record<string, unknown>, okMsg: string) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [perfilId, setPerfilId] = useState("");
  const [creating, setCreating] = useState(false);

  async function crear() {
    if (!email.trim() || !password || !perfilId) {
      onError("Completá email, contraseña y perfil.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/admin/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), name: name.trim() || null, password, perfilId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) onError(j.error || "Error al crear el usuario");
      else {
        setShowForm(false);
        setEmail(""); setName(""); setPassword(""); setPerfilId("");
        onCreated();
      }
    } finally {
      setCreating(false);
    }
  }

  function resetPassword(u: UserRow) {
    const pwd = window.prompt(`Nueva contraseña para ${u.email} (mínimo 8 caracteres):`);
    if (pwd === null) return;
    if (pwd.length < 8) { onError("La contraseña debe tener al menos 8 caracteres."); return; }
    onPatch(u.id, { password: pwd }, "Contraseña actualizada.");
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-brand">Usuarios</h2>
          <p className="text-xs text-text-muted">Cada usuario tiene un perfil que define qué puede ver y hacer.</p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90"
        >
          {showForm ? "Cancelar" : "+ Nuevo usuario"}
        </button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border-soft bg-bg-soft/40 p-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input" type="email" placeholder="email@moregiros.cl" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="input" type="text" placeholder="Nombre (opcional)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" type="password" placeholder="Contraseña (min 8)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="flex gap-2">
            <select className="input flex-1" value={perfilId} onChange={(e) => setPerfilId(e.target.value)}>
              <option value="">— Perfil —</option>
              {perfiles.map((p) => (
                <option key={p.id} value={p.id}>{p.nombre}</option>
              ))}
            </select>
            <button onClick={crear} disabled={creating} className="rounded-md bg-brand text-white px-3 text-sm font-semibold hover:opacity-90 disabled:opacity-50">
              {creating ? "…" : "Crear"}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border-soft bg-white overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
            <tr>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Nombre</th>
              <th className="px-3 py-2 text-left">Perfil</th>
              <th className="px-3 py-2 text-center">Estado</th>
              <th className="px-3 py-2 text-center">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border-soft/60">
                <td className="px-3 py-2 whitespace-nowrap">{u.email}</td>
                <td className="px-3 py-2 whitespace-nowrap">{u.name ?? "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <select
                    className="input py-1 text-xs"
                    value={u.perfilId ?? ""}
                    disabled={busy}
                    onChange={(e) => onPatch(u.id, { perfilId: e.target.value }, "Perfil actualizado.")}
                  >
                    {u.perfilId === null && <option value="">Sin perfil (solo lectura)</option>}
                    {perfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.nombre}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-center">
                  <span
                    className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                      u.active
                        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                        : "bg-zinc-100 text-zinc-600 border-zinc-200"
                    }`}
                  >
                    {u.active ? "Activo" : "Inactivo"}
                  </span>
                </td>
                <td className="px-3 py-2 text-center whitespace-nowrap">
                  <button onClick={() => resetPassword(u)} disabled={busy} className="text-brand hover:underline text-xs disabled:opacity-50">
                    Reset contraseña
                  </button>
                  <button
                    onClick={() => onPatch(u.id, { active: !u.active }, u.active ? "Usuario desactivado." : "Usuario activado.")}
                    disabled={busy}
                    className={`ml-3 text-xs hover:underline disabled:opacity-50 ${u.active ? "text-rose-700" : "text-emerald-700"}`}
                  >
                    {u.active ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ============================== Perfiles ============================== */

function PerfilesSection({
  perfiles,
  modulos,
  acciones,
  onChanged,
  onError,
}: {
  perfiles: PerfilRow[];
  modulos: string[];
  acciones: string[];
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [creating, setCreating] = useState(false);

  async function crearPerfil() {
    const nombre = window.prompt("Nombre del nuevo perfil:");
    if (!nombre?.trim()) return;
    setCreating(true);
    try {
      const permisos = {
        modulos: Object.fromEntries(modulos.map((m) => [m, true])),
        acciones: Object.fromEntries(acciones.map((a) => [a, false])),
      };
      const res = await fetch("/api/admin/perfiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: nombre.trim(), permisos }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) onError(j.error || "Error al crear el perfil");
      else onChanged("Perfil creado (arranca como solo lectura — activale acciones).");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-brand">Perfiles y sus variables</h2>
          <p className="text-xs text-text-muted">
            Módulos = qué secciones ve · Acciones = qué operaciones puede ejecutar. Los cambios aplican al instante.
          </p>
        </div>
        <button onClick={crearPerfil} disabled={creating} className="btn-ghost text-sm">
          + Nuevo perfil
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {perfiles.map((p) => (
          <PerfilCard key={p.id} perfil={p} modulos={modulos} acciones={acciones} onChanged={onChanged} onError={onError} />
        ))}
      </div>
    </section>
  );
}

function PerfilCard({
  perfil,
  modulos,
  acciones,
  onChanged,
  onError,
}: {
  perfil: PerfilRow;
  modulos: string[];
  acciones: string[];
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [permisos, setPermisos] = useState<Permisos>(perfil.permisos);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function toggle(familia: "modulos" | "acciones", key: string) {
    setPermisos((prev) => ({
      ...prev,
      [familia]: { ...prev[familia], [key]: !(prev[familia] as Record<string, boolean>)[key] },
    }));
    setDirty(true);
  }

  async function guardar() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/perfiles/${perfil.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permisos }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) onError(j.error || "Error al guardar el perfil");
      else {
        setDirty(false);
        onChanged(`Perfil "${perfil.nombre}" guardado.`);
      }
    } finally {
      setSaving(false);
    }
  }

  async function eliminar() {
    if (!confirm(`Eliminar el perfil "${perfil.nombre}"?`)) return;
    const res = await fetch(`/api/admin/perfiles/${perfil.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) onError(j.error || "Error al eliminar");
    else onChanged(`Perfil "${perfil.nombre}" eliminado.`);
  }

  const labelM = (k: string) => (MODULO_LABELS as Record<string, string>)[k] ?? k;
  const labelA = (k: string) => (ACCION_LABELS as Record<string, string>)[k] ?? k;

  return (
    <div className="rounded-lg border border-border-soft bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{perfil.nombre}</span>
          {perfil.esAdmin && (
            <span className="inline-block rounded-full bg-brand/10 text-brand border border-brand/20 px-2 py-0.5 text-[10px] font-bold">
              ADMIN · acceso total
            </span>
          )}
          <span className="text-xs text-text-muted">
            {perfil.userCount} usuario{perfil.userCount === 1 ? "" : "s"}
          </span>
        </div>
        {!perfil.esAdmin && (
          <div className="flex items-center gap-2">
            {dirty && (
              <button
                onClick={guardar}
                disabled={saving}
                className="rounded-md bg-brand text-white px-3 py-1 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar"}
              </button>
            )}
            {perfil.userCount === 0 && (
              <button onClick={eliminar} className="text-rose-700 hover:underline text-xs">
                Eliminar
              </button>
            )}
          </div>
        )}
      </div>

      {perfil.esAdmin ? (
        <p className="text-xs text-text-muted">
          Este perfil bypasea todas las variables: siempre ve y puede todo. No es editable ni eliminable.
        </p>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">
              Módulos visibles
            </div>
            <div className="space-y-1">
              {modulos.map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={permisos.modulos[m as keyof Permisos["modulos"]] === true}
                    onChange={() => toggle("modulos", m)}
                  />
                  {labelM(m)}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">
              Acciones permitidas
            </div>
            <div className="space-y-1">
              {acciones.map((a) => (
                <label key={a} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={permisos.acciones[a as keyof Permisos["acciones"]] === true}
                    onChange={() => toggle("acciones", a)}
                  />
                  {labelA(a)}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
