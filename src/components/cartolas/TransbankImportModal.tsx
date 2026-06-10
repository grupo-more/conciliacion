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

type FileItem = {
  id: string;
  file: File;
  status:
    | "previewing"
    | "previewed"
    | "preview_error"
    | "importing"
    | "imported"
    | "import_error";
  preview?: Preview;
  error?: string;
  inserted?: { rowsInserted: number };
};

let __seq = 0;
const nextId = () => `tbk${++__seq}`;

/**
 * Modal para subir el/los reporte(s) de Transbank "Abonos por dia" (.xls). Va a
 * /api/transbank/import (NO al importador de cartolas bancarias). Soporta carga
 * masiva: seleccionar varios -> preview (dryRun) por archivo -> importar todos.
 */
export function TransbankImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [finished, setFinished] = useState(false);

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newItems: FileItem[] = arr.map((f) => ({
      id: nextId(),
      file: f,
      status: "previewing",
    }));
    setItems((prev) => [...prev, ...newItems]);
    setFinished(false);
    for (const it of newItems) void previewFor(it.id, it.file);
  }

  async function previewFor(id: string, file: File) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/transbank/import?dryRun=1", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, status: "preview_error", error: j.error || "No se pudo leer el archivo." }
              : it,
          ),
        );
        return;
      }
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, status: "previewed", preview: j } : it)),
      );
    } catch {
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, status: "preview_error", error: "Error de red al leer el archivo." } : it,
        ),
      );
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  async function importAll() {
    const importable = items.filter(
      (it) => it.status === "previewed" && it.preview && !it.preview.alreadyImported && it.preview.totals.toInsert > 0,
    );
    if (importable.length === 0) return;
    setImporting(true);
    let anyInserted = false;

    for (const it of importable) {
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, status: "importing" } : x)));
      try {
        const fd = new FormData();
        fd.append("file", it.file);
        const res = await fetch("/api/transbank/import", { method: "POST", body: fd });
        const j = await res.json();
        if (!res.ok) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === it.id ? { ...x, status: "import_error", error: j.error || "Error al importar." } : x,
            ),
          );
          continue;
        }
        const rowsInserted = j.inserted?.rowsInserted ?? 0;
        if (rowsInserted > 0) anyInserted = true;
        setItems((prev) =>
          prev.map((x) => (x.id === it.id ? { ...x, status: "imported", inserted: { rowsInserted } } : x)),
        );
      } catch {
        setItems((prev) =>
          prev.map((x) =>
            x.id === it.id ? { ...x, status: "import_error", error: "Error de red al importar." } : x,
          ),
        );
      }
    }

    setImporting(false);
    setFinished(true);
    if (anyInserted) onImported();
  }

  const previewing = items.filter((it) => it.status === "previewing").length;
  const importableItems = items.filter(
    (it) => it.status === "previewed" && it.preview && !it.preview.alreadyImported && it.preview.totals.toInsert > 0,
  );
  const totalToInsert = importableItems.reduce((acc, it) => acc + (it.preview?.totals.toInsert ?? 0), 0);
  const totalInserted = items.reduce((acc, it) => acc + (it.inserted?.rowsInserted ?? 0), 0);
  const importedCount = items.filter((it) => it.status === "imported").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="card w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Subir abonos Transbank</h2>
            <p className="text-sm text-text-muted mt-0.5">
              Reporte "Abonos por día" de Transbank (.xls). Podés seleccionar varios. Se cruza
              luego en Consolidados → Cruce Transbank.
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text">✕</button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".xls,.xlsx"
          multiple
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
          className="hidden"
        />

        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => fileRef.current?.click()} className="btn-ghost" disabled={importing}>
            {items.length === 0 ? "Seleccionar archivos .xls" : "+ Agregar más"}
          </button>
          {items.length > 0 && (
            <span className="text-sm text-text-muted">
              {items.length} archivo{items.length === 1 ? "" : "s"}
              {previewing > 0 && ` · analizando ${previewing}…`}
            </span>
          )}
        </div>

        {finished && (
          <div className="mt-3 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
            ✓ Importado: {totalInserted} venta{totalInserted === 1 ? "" : "s"} nueva
            {totalInserted === 1 ? "" : "s"} en {importedCount} archivo{importedCount === 1 ? "" : "s"}.
            <button onClick={onClose} className="ml-2 underline">cerrar</button>
          </div>
        )}

        {items.length > 0 && (
          <div className="mt-4 space-y-2">
            {items.map((it) => (
              <FileRow
                key={it.id}
                item={it}
                onRemove={!importing && !finished ? () => removeItem(it.id) : undefined}
              />
            ))}
          </div>
        )}

        {items.length > 0 && !finished && (
          <div className="mt-4 flex justify-end gap-2 border-t border-border-soft pt-3">
            <button onClick={onClose} className="btn-ghost">Cancelar</button>
            <button
              onClick={importAll}
              disabled={importing || previewing > 0 || importableItems.length === 0}
              className="btn-primary"
            >
              {importing
                ? "Importando…"
                : importableItems.length === 0
                ? "Nada por importar"
                : `Importar ${importableItems.length} archivo${importableItems.length === 1 ? "" : "s"} (${totalToInsert} ventas)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({ item, onRemove }: { item: FileItem; onRemove?: () => void }) {
  const { file, status, preview, error, inserted } = item;
  return (
    <div className="rounded-lg border border-border-soft bg-bg-soft/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" title={file.name}>{file.name}</div>
          <StatusLine item={item} />
        </div>
        {onRemove && (
          <button onClick={onRemove} className="text-text-muted hover:text-text text-xs shrink-0" title="Quitar">
            ✕
          </button>
        )}
      </div>

      {status === "preview_error" && error && <div className="mt-1 text-xs text-rose-700">{error}</div>}
      {status === "import_error" && error && <div className="mt-1 text-xs text-rose-700">{error}</div>}

      {preview && !preview.alreadyImported && (
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <Stat label="Filas" value={preview.totals.fileRows} />
          <Stat label={status === "imported" ? "Insertadas" : "A insertar"} value={status === "imported" ? (inserted?.rowsInserted ?? 0) : preview.totals.toInsert} tone="ok" />
          <Stat label="Duplicados" value={preview.totals.duplicates} />
          <Stat label="Errores" value={preview.totals.parseErrors} tone={preview.totals.parseErrors ? "bad" : undefined} />
        </div>
      )}
      {preview?.alreadyImported && (
        <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          Ya importado el {formatDate(preview.alreadyImported.importedAt)}. No se reinsertará.
        </div>
      )}
      {preview && (preview.empresaRut || preview.cuentaAbono) && (
        <div className="mt-1 text-xs text-text-muted">
          Empresa RUT: <b>{preview.empresaRut ?? "—"}</b> · Cuenta abono: <b>{preview.cuentaAbono ?? "—"}</b>
        </div>
      )}
    </div>
  );
}

function StatusLine({ item }: { item: FileItem }) {
  switch (item.status) {
    case "previewing":
      return <div className="text-xs text-text-muted">Analizando…</div>;
    case "preview_error":
      return <div className="text-xs text-rose-700">No se pudo procesar</div>;
    case "importing":
      return <div className="text-xs text-text-muted">Importando…</div>;
    case "imported":
      return <div className="text-xs text-emerald-700">✓ Importado · {item.inserted?.rowsInserted ?? 0} ventas</div>;
    case "import_error":
      return <div className="text-xs text-rose-700">Falló la importación</div>;
    case "previewed": {
      const p = item.preview;
      if (!p) return null;
      if (p.alreadyImported) return null;
      if (p.totals.toInsert === 0) return <div className="text-xs text-text-muted">Sin ventas nuevas (todo duplicado)</div>;
      return <div className="text-xs text-text-muted">{p.totals.toInsert} a insertar</div>;
    }
  }
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
