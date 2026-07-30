"use client";

import { useEffect, useState } from "react";

interface Rubro {
  rubro: number;
  name: string;
  isDifference: boolean;
}

interface Settings {
  rubroDebe: number;
  rubroHaber: number;
}

/**
 * Tab "Abonos Transbank" en Configuración. Edita los 2 rubros del asiento de
 * Cruce Transbank → Abonos conciliados (abonos/cargos ajenos a la empresa):
 * Debe rubroDebe (default 200) / Haber rubroHaber (default 1403), por el neto.
 */
export function AbonosTransbankTab() {
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [rubroDebe, setRubroDebe] = useState<string>("");
  const [rubroHaber, setRubroHaber] = useState<string>("");
  const [original, setOriginal] = useState<Settings | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [sRes, rRes] = await Promise.all([
        fetch("/api/abono-conciliado-settings"),
        fetch("/api/rubros"),
      ]);
      if (!sRes.ok || !rRes.ok) {
        setError("No se pudo cargar la configuración.");
        return;
      }
      const s: Settings = await sRes.json();
      const r = await rRes.json();
      setRubroDebe(String(s.rubroDebe));
      setRubroHaber(String(s.rubroHaber));
      setOriginal({ rubroDebe: s.rubroDebe, rubroHaber: s.rubroHaber });
      setRubros(r.rubros);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setError(null);
    const debeNum = Number(rubroDebe);
    const haberNum = Number(rubroHaber);
    if (!Number.isInteger(debeNum) || debeNum <= 0 || !Number.isInteger(haberNum) || haberNum <= 0) {
      setError("Seleccioná rubros válidos en ambos lados.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/abono-conciliado-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rubroDebe: debeNum, rubroHaber: haberNum }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error || "No se pudo guardar.");
        return;
      }
      const updated: Settings = await res.json();
      setOriginal(updated);
      setSavedAt(new Date().toISOString());
    } finally {
      setSaving(false);
    }
  }

  const dirty =
    original !== null &&
    (Number(rubroDebe) !== original.rubroDebe || Number(rubroHaber) !== original.rubroHaber);

  const rubroSelect = (
    id: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
    >
      <option value="">— Seleccionar —</option>
      {rubros
        .slice()
        .sort((a, b) => a.rubro - b.rubro)
        .map((r) => (
          <option key={r.rubro} value={r.rubro}>
            {r.rubro} — {r.name}
            {r.isDifference ? " (diferencia)" : ""}
          </option>
        ))}
    </select>
  );

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Abonos Transbank (ajenos)</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Rubros del asiento de Consolidados → Cruce Transbank → Abonos
          conciliados: abonos o cargos del settlement que no corresponden a
          operaciones de la empresa (jamás tendrán POS). Se contabilizan por el
          neto, siempre con el mismo lado: Debe / Haber.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card text-center py-8 text-sm text-text-muted">Cargando…</div>
      ) : (
        <div className="card space-y-4">
          <div>
            <label htmlFor="abono-rubro-debe" className="block text-sm font-medium mb-1">
              Rubro lado Debe
            </label>
            {rubroSelect("abono-rubro-debe", rubroDebe, setRubroDebe)}
            <p className="text-xs text-text-muted mt-1">Por defecto 200.</p>
          </div>

          <div>
            <label htmlFor="abono-rubro-haber" className="block text-sm font-medium mb-1">
              Rubro lado Haber
            </label>
            {rubroSelect("abono-rubro-haber", rubroHaber, setRubroHaber)}
            <p className="text-xs text-text-muted mt-1">Por defecto 1403.</p>
          </div>

          <div className="flex items-center justify-between border-t border-border-soft pt-3">
            <div className="text-xs text-text-muted">
              {savedAt && !dirty && <span className="text-success">✓ Guardado</span>}
              {dirty && <span className="text-amber-700">Hay cambios sin guardar</span>}
            </div>
            <button onClick={save} disabled={!dirty || saving} className="btn-primary">
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
