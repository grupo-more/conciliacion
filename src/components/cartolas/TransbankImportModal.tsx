"use client";

import { useRef, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";

interface Preview {
  fileName: string;
  empresaRut: string | null;
  cuentaAbono: string | null;
  totals: { fileRows: number; toInsert: number; duplicates: number; parseErrors: number };
  alreadyImported?: { importedAt: string; importId: string };
  sampleSales: Array<{
    fechaVenta: string;
    nombreLocal: string;
    sucursalId: number | null;
    medioPago: string;
    montoVenta: string;
    comision: string;
    totalAbono: string;
    numeroBoleta: string | null;
    status: "NEW" | "DUP";
  }>;
  error?: string;
}

/**
 * Modal para subir el reporte de Transbank "Abonos por dia" (.xls). Va a
 * /api/transbank/import (NO al importador de cartolas bancarias). Flujo:
 * seleccionar archivo -> preview (dryRun) -> confirmar.
 */
export function TransbankImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ rowsInserted: number } | null>(null);

  async function runPreview(f: File) {
    setLoading(true);
    setError(null);
    setPreview(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/transbank/import?dryRun=1", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) setError(j.error || "No se pudo leer el archivo.");
      else setPreview(j);
    } catch {
      setError("Error de red al leer el archivo.");
    } finally {
      setLoading(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f) runPreview(f);
  }

  async function confirmImport() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/transbank/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "Error al importar.");
      } else {
        setDone({ rowsInserted: j.inserted?.rowsInserted ?? 0 });
        onImported();
      }
    } catch {
      setError("Error de red al importar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Subir abonos Transbank</h2>
            <p className="text-sm text-text-muted mt-0.5">
              Reporte "Abonos por día" de Transbank (.xls). Se cruza luego en
              Consolidados → Cruce Transbank.
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text">✕</button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".xls,.xlsx"
          onChange={onPick}
          className="hidden"
        />

        <div className="mt-4">
          <button onClick={() => fileRef.current?.click()} className="btn-ghost" disabled={loading}>
            {file ? `Archivo: ${file.name}` : "Seleccionar archivo .xls"}
          </button>
        </div>

        {loading && <p className="mt-3 text-sm text-text-muted">Procesando…</p>}
        {error && (
          <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}

        {done && (
          <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            ✓ Importado: {done.rowsInserted} venta{done.rowsInserted === 1 ? "" : "s"} nueva
            {done.rowsInserted === 1 ? "" : "s"}.
            <button onClick={onClose} className="ml-2 underline">cerrar</button>
          </div>
        )}

        {preview && !done && (
          <div className="mt-4 space-y-3">
            <div className="text-sm text-text-muted">
              Empresa RUT: <b>{preview.empresaRut ?? "—"}</b> · Cuenta abono:{" "}
              <b>{preview.cuentaAbono ?? "—"}</b>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <Stat label="Filas" value={preview.totals.fileRows} />
              <Stat label="A insertar" value={preview.totals.toInsert} tone="ok" />
              <Stat label="Duplicados" value={preview.totals.duplicates} />
              <Stat label="Errores" value={preview.totals.parseErrors} tone={preview.totals.parseErrors ? "bad" : undefined} />
            </div>
            {preview.alreadyImported && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
                Este archivo ya fue importado el {formatDate(preview.alreadyImported.importedAt)}. No se reinsertará.
              </div>
            )}

            <div className="rounded-lg border border-border-soft overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-bg-soft text-text-muted uppercase tracking-wider">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Fecha</th>
                    <th className="px-2 py-1.5 text-left">Local</th>
                    <th className="px-2 py-1.5 text-left">Medio</th>
                    <th className="px-2 py-1.5 text-right">Bruto</th>
                    <th className="px-2 py-1.5 text-right">Comisión</th>
                    <th className="px-2 py-1.5 text-right">Neto</th>
                    <th className="px-2 py-1.5 text-left">Boleta</th>
                    <th className="px-2 py-1.5 text-left">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleSales.map((s, i) => (
                    <tr key={i} className="border-t border-border-soft/50">
                      <td className="px-2 py-1 whitespace-nowrap">{formatDate(s.fechaVenta)}</td>
                      <td className="px-2 py-1 max-w-[200px] truncate" title={s.nombreLocal}>
                        {s.nombreLocal}
                        {s.sucursalId == null && (
                          <span className="ml-1 text-amber-600" title="Sucursal sin resolver (no afecta el cruce)">⚠</span>
                        )}
                      </td>
                      <td className="px-2 py-1">{s.medioPago}</td>
                      <td className="px-2 py-1 text-right font-mono">${formatMoney(BigInt(s.montoVenta))}</td>
                      <td className="px-2 py-1 text-right font-mono text-text-muted">${formatMoney(BigInt(s.comision))}</td>
                      <td className="px-2 py-1 text-right font-mono">${formatMoney(BigInt(s.totalAbono))}</td>
                      <td className="px-2 py-1 font-mono">{s.numeroBoleta ?? "—"}</td>
                      <td className="px-2 py-1">
                        <span className={s.status === "NEW" ? "text-emerald-700" : "text-text-muted"}>
                          {s.status === "NEW" ? "Nuevo" : "Dup"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn-ghost">Cancelar</button>
              <button
                onClick={confirmImport}
                disabled={loading || preview.totals.toInsert === 0}
                className="btn-primary"
              >
                {preview.totals.toInsert === 0 ? "Nada por importar" : `Importar ${preview.totals.toInsert} ventas`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  const cls = tone === "ok" ? "text-emerald-700" : tone === "bad" ? "text-rose-700" : "text-text";
  return (
    <div className="rounded-lg border border-border-soft bg-bg-elevated px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
