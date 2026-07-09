"use client";

import { useEffect, useState } from "react";

/**
 * Configuración → Descartes automáticos.
 *
 * Reglas que se aplican AL IMPORTAR cartolas: los movimientos cuya contraparte
 * o glosa contiene el patrón entran directo a "Movimientos descartados" (no
 * concilian ni cuentan como pendientes). Caso típico: inversiones de More
 * Capital vía "Motale" / "Vector Capital", que no son flujo del negocio.
 */

interface Regla {
  id: string;
  patron: string;
  accountId: string | null;
  accountLabel: string | null;
  active: boolean;
  nota: string | null;
  createdAt: string;
}

interface Cuenta {
  id: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  displayNumber: string | null;
  isUnassigned: boolean;
}

export function DescartesTab() {
  const [reglas, setReglas] = useState<Regla[] | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [nPatron, setNPatron] = useState("");
  const [nAccountId, setNAccountId] = useState("");
  const [nNota, setNNota] = useState("");

  async function load() {
    const [r1, r2] = await Promise.all([
      fetch("/api/descarte-reglas"),
      fetch("/api/bank-accounts"),
    ]);
    if (r1.ok) setReglas((await r1.json()).reglas);
    if (r2.ok) {
      const j = await r2.json();
      setCuentas((j.accounts as Cuenta[]).filter((a) => !a.isUnassigned));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function crear() {
    if (nPatron.trim().length < 3) {
      setErr("El patrón debe tener al menos 3 caracteres (para no descartar de más).");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/descarte-reglas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patron: nPatron.trim(),
          accountId: nAccountId || null,
          nota: nNota.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j.error || "Error al crear la regla");
      else {
        setNPatron("");
        setNNota("");
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r: Regla) {
    setBusy(true);
    try {
      await fetch(`/api/descarte-reglas?id=${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !r.active }),
      });
      load();
    } finally {
      setBusy(false);
    }
  }

  async function eliminar(r: Regla) {
    if (
      !confirm(
        `Eliminar la regla "${r.patron}"? Los movimientos ya descartados NO se restauran (eso se hace desde Cartolas → descartados).`,
      )
    )
      return;
    setBusy(true);
    try {
      await fetch(`/api/descarte-reglas?id=${r.id}`, { method: "DELETE" });
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-base font-semibold">Descartes automáticos</h2>
        <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
          Al importar una cartola, los movimientos cuya <b>contraparte o glosa contiene el patrón</b> se
          insertan directo a <b>Movimientos descartados</b>: no concilian ni cuentan como pendientes en
          ninguna vista, y quedan auditables con la regla como razón. Útil para flujos que no son del
          negocio (ej. inversiones de More Capital vía corredores).
        </p>
      </div>

      {err && (
        <div className="rounded-md bg-rose-50 text-rose-800 border border-rose-200 px-3 py-2 text-sm">
          {err}
        </div>
      )}

      {/* Alta */}
      <div className="card space-y-3">
        <h3 className="text-sm font-semibold">Nueva regla</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted">Patrón (contiene)</span>
            <input
              type="text"
              value={nPatron}
              onChange={(e) => setNPatron(e.target.value)}
              placeholder="ej: Motale"
              maxLength={120}
              className="input w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Cuenta (opcional)</span>
            <select value={nAccountId} onChange={(e) => setNAccountId(e.target.value)} className="input w-full">
              <option value="">Todas las cuentas</option>
              {cuentas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.bankName} · {c.holderName} · {c.displayNumber ?? c.accountNumber}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Nota (opcional)</span>
            <input
              type="text"
              value={nNota}
              onChange={(e) => setNNota(e.target.value)}
              placeholder="ej: inversiones More Capital, no es flujo del negocio"
              maxLength={500}
              className="input w-full"
            />
          </label>
        </div>
        <div className="flex justify-end">
          <button
            onClick={crear}
            disabled={busy}
            className="rounded-md bg-brand text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Guardando…" : "Agregar regla"}
          </button>
        </div>
        <p className="text-xs text-text-muted">
          La regla aplica solo a importaciones futuras. Los movimientos ya insertados se descartan a mano
          desde Cartolas (multi-select → Descartar), como ya hiciste con Motale/Vector.
        </p>
      </div>

      {/* Lista */}
      <div className="card">
        <h3 className="text-sm font-semibold mb-2">Reglas ({reglas?.length ?? "…"})</h3>
        {reglas && reglas.length === 0 && (
          <p className="text-sm text-text-muted">Sin reglas. Agrega la primera arriba.</p>
        )}
        {reglas && reglas.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-2 py-1.5 text-left">Patrón</th>
                <th className="px-2 py-1.5 text-left">Cuenta</th>
                <th className="px-2 py-1.5 text-left">Nota</th>
                <th className="px-2 py-1.5 text-center">Activa</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {reglas.map((r) => (
                <tr key={r.id} className={`border-t border-border-soft/60 ${r.active ? "" : "opacity-50"}`}>
                  <td className="px-2 py-1.5 font-mono">{r.patron}</td>
                  <td className="px-2 py-1.5">{r.accountLabel ?? <span className="text-text-muted">Todas</span>}</td>
                  <td className="px-2 py-1.5 text-text-muted max-w-[240px] truncate" title={r.nota ?? ""}>
                    {r.nota ?? "—"}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={r.active} onChange={() => toggle(r)} className="accent-brand" />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      onClick={() => eliminar(r)}
                      disabled={busy}
                      className="text-rose-700 hover:underline text-xs disabled:opacity-50"
                    >
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
