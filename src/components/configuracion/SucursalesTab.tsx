"use client";

import { useEffect, useState } from "react";

interface Sucursal {
  id: string;
  codigo: number | null;
  nombre: string;
  headcount: number;
  active: boolean;
  orden: number;
}

interface Rubro {
  rubro: number;
  name: string;
}

/**
 * Tab "Sucursales" en Configuración. Maestro de sucursales con su headcount
 * (Nº de personas, puede ser fraccionado) para el prorrateo de los asientos
 * manuales, más la tasa de retención de honorarios y su rubro destino.
 */
export function SucursalesTab() {
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [retTasa, setRetTasa] = useState("0");
  const [retRubro, setRetRubro] = useState("26");
  const [origSettings, setOrigSettings] = useState<{ tasa: number; rubro: number } | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Form de nueva sucursal
  const [nCodigo, setNCodigo] = useState("");
  const [nNombre, setNNombre] = useState("");
  const [nHeadcount, setNHeadcount] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sRes, rRes, stRes] = await Promise.all([
        fetch("/api/sucursales"),
        fetch("/api/rubros"),
        fetch("/api/asientos-settings"),
      ]);
      if (!sRes.ok || !rRes.ok || !stRes.ok) {
        setError("No se pudo cargar la configuración.");
        return;
      }
      const s = await sRes.json();
      const r = await rRes.json();
      const st = await stRes.json();
      setSucursales(s.sucursales);
      setRubros(r.rubros);
      setRetTasa(String(st.retencionTasa));
      setRetRubro(String(st.retencionRubro));
      setOrigSettings({ tasa: st.retencionTasa, rubro: st.retencionRubro });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function saveSettings() {
    setError(null);
    setSavingSettings(true);
    try {
      const res = await fetch("/api/asientos-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retencionTasa: Number(retTasa), retencionRubro: Number(retRubro) }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error || "No se pudo guardar.");
        return;
      }
      const st = await res.json();
      setOrigSettings({ tasa: st.retencionTasa, rubro: st.retencionRubro });
    } finally {
      setSavingSettings(false);
    }
  }

  async function addSucursal() {
    setError(null);
    if (!nNombre.trim()) {
      setError("El nombre de la sucursal es obligatorio.");
      return;
    }
    const res = await fetch("/api/sucursales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codigo: nCodigo ? Number(nCodigo) : null,
        nombre: nNombre.trim(),
        headcount: Number(nHeadcount) || 0,
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setError(e.error || "No se pudo crear.");
      return;
    }
    setNCodigo("");
    setNNombre("");
    setNHeadcount("");
    await load();
  }

  async function patchSucursal(id: string, data: Partial<Sucursal>) {
    const res = await fetch(`/api/sucursales/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setError(e.error || "No se pudo actualizar.");
      await load();
    }
  }

  async function removeSucursal(id: string) {
    if (!confirm("¿Eliminar esta sucursal? Si tiene asientos, se desactiva en vez de borrarse.")) return;
    const res = await fetch(`/api/sucursales/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setError(e.error || "No se pudo eliminar.");
    }
    await load();
  }

  const settingsDirty =
    origSettings !== null &&
    (Number(retTasa) !== origSettings.tasa || Number(retRubro) !== origSettings.rubro);

  const totalHeadcount = sucursales.filter((s) => s.active).reduce((a, s) => a + s.headcount, 0);

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h2 className="text-base font-semibold">Sucursales y retención</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Maestro de sucursales con su headcount (Nº de personas) para el prorrateo de los
          asientos manuales, y la tasa de retención de honorarios.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-3 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="card text-center py-8 text-sm text-text-muted">Cargando…</div>
      ) : (
        <>
          {/* Retención */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold">Retención de honorarios</h3>
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-sm font-medium mb-1">Tasa vigente (%)</label>
                <input
                  type="number" step="0.01" min="0" value={retTasa}
                  onChange={(e) => setRetTasa(e.target.value)}
                  className="w-32 rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Rubro destino</label>
                <select
                  value={retRubro}
                  onChange={(e) => setRetRubro(e.target.value)}
                  className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
                >
                  {rubros.slice().sort((a, b) => a.rubro - b.rubro).map((r) => (
                    <option key={r.rubro} value={r.rubro}>{r.rubro} — {r.name}</option>
                  ))}
                </select>
              </div>
              <button onClick={saveSettings} disabled={!settingsDirty || savingSettings} className="btn-primary">
                {savingSettings ? "Guardando…" : "Guardar"}
              </button>
              {settingsDirty && <span className="text-xs text-amber-700">Cambios sin guardar</span>}
            </div>
            <p className="text-xs text-text-muted">
              La tasa se aplica sobre el neto del banco y se suma para formar el bruto. Editable
              también en cada asiento. Rubro por defecto 26.
            </p>
          </div>

          {/* Sucursales */}
          <div className="card space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Sucursales</h3>
              <span className="text-xs text-text-muted">Total activas: <strong>{totalHeadcount}</strong> personas</span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left">Código</th>
                  <th className="px-2 py-1.5 text-left">Nombre</th>
                  <th className="px-2 py-1.5 text-right">Personas</th>
                  <th className="px-2 py-1.5 text-center">Activa</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {sucursales.map((s) => (
                  <tr key={s.id} className="border-t border-border-soft/60">
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        defaultValue={s.codigo ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value ? Number(e.target.value) : null;
                          if (v !== s.codigo) patchSucursal(s.id, { codigo: v });
                        }}
                        className="w-20 rounded-md border border-border-soft px-1.5 py-0.5"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        defaultValue={s.nombre}
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value !== s.nombre)
                            patchSucursal(s.id, { nombre: e.target.value.trim() });
                        }}
                        className="w-full rounded-md border border-border-soft px-1.5 py-0.5"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number" step="0.5" min="0"
                        defaultValue={s.headcount}
                        onBlur={(e) => {
                          const v = Number(e.target.value) || 0;
                          if (v !== s.headcount) patchSucursal(s.id, { headcount: v });
                        }}
                        className="w-20 rounded-md border border-border-soft px-1.5 py-0.5 text-right"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={s.active}
                        onChange={(e) => patchSucursal(s.id, { active: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button onClick={() => removeSucursal(s.id)} className="text-xs text-rose-700 hover:underline">
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
                {sucursales.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-4 text-center text-text-muted text-xs">No hay sucursales cargadas.</td></tr>
                )}
              </tbody>
            </table>

            {/* Alta */}
            <div className="flex flex-wrap items-end gap-2 border-t border-border-soft pt-3">
              <div>
                <label className="block text-xs text-text-muted mb-0.5">Código</label>
                <input type="number" value={nCodigo} onChange={(e) => setNCodigo(e.target.value)} placeholder="207" className="w-20 rounded-md border border-border-soft px-2 py-1 text-sm" />
              </div>
              <div className="flex-1 min-w-[160px]">
                <label className="block text-xs text-text-muted mb-0.5">Nombre</label>
                <input type="text" value={nNombre} onChange={(e) => setNNombre(e.target.value)} placeholder="San Sebastián" className="w-full rounded-md border border-border-soft px-2 py-1 text-sm" />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-0.5">Personas</label>
                <input type="number" step="0.5" min="0" value={nHeadcount} onChange={(e) => setNHeadcount(e.target.value)} placeholder="3" className="w-20 rounded-md border border-border-soft px-2 py-1 text-sm" />
              </div>
              <button onClick={addSucursal} className="btn-primary">Agregar</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
