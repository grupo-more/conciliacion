"use client";

import { useEffect, useState } from "react";

/**
 * Configuración → Proveedores: maestro que deriva movimientos de banco sin
 * conciliar a la tab "Proveedores" de Consolidados (cola de trabajo delegable).
 * Match: RUT primero (certero — pesca glosas tipo "Internet a 77.988.819-3"),
 * patrones de texto como respaldo (glosas sin RUT).
 */

interface Proveedor {
  id: string;
  nombre: string;
  rut: string | null;
  patrones: string[];
  active: boolean;
  nota: string | null;
}

export function ProveedoresTab() {
  const [proveedores, setProveedores] = useState<Proveedor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [nNombre, setNNombre] = useState("");
  const [nRut, setNRut] = useState("");
  const [nPatrones, setNPatrones] = useState("");
  const [nNota, setNNota] = useState("");

  async function load() {
    const res = await fetch("/api/proveedores-asiento");
    if (res.ok) setProveedores((await res.json()).proveedores);
  }
  useEffect(() => {
    load();
  }, []);

  async function crear() {
    const patrones = nPatrones.split(",").map((s) => s.trim()).filter((s) => s.length >= 3);
    if (nNombre.trim().length < 2) {
      setErr("Falta el nombre del proveedor.");
      return;
    }
    if (!nRut.trim() && patrones.length === 0) {
      setErr("Definí al menos el RUT (recomendado) o un patrón de texto de 3+ caracteres.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/proveedores-asiento", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: nNombre.trim(),
          rut: nRut.trim() || null,
          patrones,
          nota: nNota.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j.error || "Error al crear");
      else {
        setNNombre("");
        setNRut("");
        setNPatrones("");
        setNNota("");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggle(p: Proveedor) {
    setBusy(true);
    try {
      await fetch(`/api/proveedores-asiento?id=${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !p.active }),
      });
      load();
    } finally {
      setBusy(false);
    }
  }

  async function eliminar(p: Proveedor) {
    if (
      !confirm(
        `Eliminar "${p.nombre}" del maestro? Sus movimientos pendientes vuelven a Asientos manuales. ` +
          `Los asientos ya generados/emitidos desde la tab Proveedores NO cambian de cola.`,
      )
    )
      return;
    setBusy(true);
    try {
      await fetch(`/api/proveedores-asiento?id=${p.id}`, { method: "DELETE" });
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-base font-semibold">Proveedores</h2>
        <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
          Los movimientos de banco sin conciliar que matchean este maestro se derivan a la tab{" "}
          <b>Consolidados → Proveedores</b> (y salen de Asientos manuales). El match usa el <b>RUT</b>{" "}
          primero — pesca también glosas tipo &quot;Transf.Internet a 77.988.819-3&quot; — y los patrones
          de texto como respaldo para bancos que no informan RUT.
        </p>
      </div>

      {err && (
        <div className="rounded-md bg-rose-50 text-rose-800 border border-rose-200 px-3 py-2 text-sm">
          {err}
        </div>
      )}

      {/* Alta */}
      <div className="card space-y-3">
        <h3 className="text-sm font-semibold">Nuevo proveedor</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted">Nombre</span>
            <input type="text" value={nNombre} onChange={(e) => setNNombre(e.target.value)} placeholder="ej: KUSHKI CHILE" maxLength={120} className="input w-full" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">RUT (recomendado)</span>
            <input type="text" value={nRut} onChange={(e) => setNRut(e.target.value)} placeholder="ej: 76.693.142-1" maxLength={20} className="input w-full font-mono" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Patrones de texto (separados por coma, opcional)</span>
            <input type="text" value={nPatrones} onChange={(e) => setNPatrones(e.target.value)} placeholder="ej: KUSHKI, Kushki Chile S" maxLength={500} className="input w-full" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Nota (opcional)</span>
            <input type="text" value={nNota} onChange={(e) => setNNota(e.target.value)} placeholder="ej: pasarela de pagos" maxLength={500} className="input w-full" />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            onClick={crear}
            disabled={busy}
            className="rounded-md bg-brand text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Guardando…" : "Agregar proveedor"}
          </button>
        </div>
      </div>

      {/* Lista */}
      <div className="card">
        <h3 className="text-sm font-semibold mb-2">Maestro ({proveedores?.length ?? "…"})</h3>
        {proveedores && proveedores.length === 0 && (
          <p className="text-sm text-text-muted">Sin proveedores. La tab Proveedores estará vacía hasta que agregues el primero.</p>
        )}
        {proveedores && proveedores.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-2 py-1.5 text-left">Nombre</th>
                <th className="px-2 py-1.5 text-left">RUT</th>
                <th className="px-2 py-1.5 text-left">Patrones</th>
                <th className="px-2 py-1.5 text-left">Nota</th>
                <th className="px-2 py-1.5 text-center">Activo</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {proveedores.map((p) => (
                <tr key={p.id} className={`border-t border-border-soft/60 ${p.active ? "" : "opacity-50"}`}>
                  <td className="px-2 py-1.5 font-semibold">{p.nombre}</td>
                  <td className="px-2 py-1.5 font-mono text-xs">{p.rut ?? "—"}</td>
                  <td className="px-2 py-1.5 text-xs text-text-muted max-w-[200px] truncate" title={p.patrones.join(", ")}>
                    {p.patrones.length ? p.patrones.join(", ") : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-text-muted max-w-[180px] truncate" title={p.nota ?? ""}>{p.nota ?? "—"}</td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={p.active} onChange={() => toggle(p)} className="accent-brand" />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button onClick={() => eliminar(p)} disabled={busy} className="text-rose-700 hover:underline text-xs disabled:opacity-50">
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
