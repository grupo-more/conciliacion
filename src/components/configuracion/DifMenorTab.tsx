"use client";

import { useEffect, useState } from "react";

interface Rubro {
  rubro: number;
  name: string;
  isDifference: boolean;
}

interface Settings {
  threshold: number;
  rubroDiferencia: number;
  rubroComision: number;
}

/**
 * Tab "Diferencias y comisiones" en Configuración. Edita el umbral (CLP) y los
 * rubros de destino del módulo Consolidados → Diferencias y comisiones:
 * rubroDiferencia (transferencias chicas) y rubroComision (comisiones/cargos
 * del propio banco).
 */
export function DifMenorTab() {
  const [rubros, setRubros] = useState<Rubro[]>([]);
  const [threshold, setThreshold] = useState<string>("100");
  const [rubroDiferencia, setRubroDiferencia] = useState<string>("");
  const [rubroComision, setRubroComision] = useState<string>("");
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
        fetch("/api/dif-menor-settings"),
        fetch("/api/rubros"),
      ]);
      if (!sRes.ok || !rRes.ok) {
        setError("No se pudo cargar la configuración.");
        return;
      }
      const s: Settings = await sRes.json();
      const r = await rRes.json();
      setThreshold(String(s.threshold));
      setRubroDiferencia(String(s.rubroDiferencia));
      setRubroComision(String(s.rubroComision));
      setOriginal({
        threshold: s.threshold,
        rubroDiferencia: s.rubroDiferencia,
        rubroComision: s.rubroComision,
      });
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
    const thNum = Number(threshold);
    const rdNum = Number(rubroDiferencia);
    const rcNum = Number(rubroComision);
    if (!Number.isInteger(thNum) || thNum <= 0) {
      setError("El umbral debe ser un entero positivo (en CLP).");
      return;
    }
    if (!Number.isInteger(rdNum) || rdNum <= 0 || !Number.isInteger(rcNum) || rcNum <= 0) {
      setError("Seleccioná rubros válidos en ambos destinos.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/dif-menor-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threshold: thNum, rubroDiferencia: rdNum, rubroComision: rcNum }),
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
    (Number(threshold) !== original.threshold ||
      Number(rubroDiferencia) !== original.rubroDiferencia ||
      Number(rubroComision) !== original.rubroComision);

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold">Diferencias y comisiones</h2>
        <p className="text-sm text-text-muted mt-0.5">
          Configura el módulo Consolidados → Diferencias y comisiones: el umbral
          y rubro de las transferencias chicas (ingresos/egresos de prueba), y el
          rubro destino de las comisiones y cargos del propio banco.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 text-danger p-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card text-center py-8 text-sm text-text-muted">
          Cargando…
        </div>
      ) : (
        <div className="card space-y-4">
          <div>
            <label
              htmlFor="dif-threshold"
              className="block text-sm font-medium mb-1"
            >
              Umbral (CLP)
            </label>
            <input
              id="dif-threshold"
              type="number"
              min="1"
              step="1"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-full rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
            />
            <p className="text-xs text-text-muted mt-1">
              Todo ingreso IN cuyo monto sea <strong>menor o igual</strong> a
              este valor entra al módulo.
            </p>
          </div>

          <div>
            <label
              htmlFor="dif-rubro"
              className="block text-sm font-medium mb-1"
            >
              Rubro de diferencia (lado Haber)
            </label>
            <select
              id="dif-rubro"
              value={rubroDiferencia}
              onChange={(e) => setRubroDiferencia(e.target.value)}
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
            <p className="text-xs text-text-muted mt-1">
              El rubro contable contra el que se mandan estas transferencias
              chicas. Por defecto 2050.
            </p>
          </div>

          <div>
            <label htmlFor="dif-rubro-comision" className="block text-sm font-medium mb-1">
              Rubro de comisiones bancarias (lado Debe)
            </label>
            <select
              id="dif-rubro-comision"
              value={rubroComision}
              onChange={(e) => setRubroComision(e.target.value)}
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
            <p className="text-xs text-text-muted mt-1">
              Destino de las comisiones/cargos del propio banco (cargos sin
              contraparte cuya glosa menciona comisión, mantención, impuesto,
              IVA o cobro). Por defecto 1503.
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-border-soft pt-3">
            <div className="text-xs text-text-muted">
              {savedAt && !dirty && (
                <span className="text-success">✓ Guardado</span>
              )}
              {dirty && (
                <span className="text-amber-700">
                  Hay cambios sin guardar
                </span>
              )}
            </div>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="btn-primary"
            >
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
