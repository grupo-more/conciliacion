"use client";

import { useEffect, useRef, useState } from "react";
import type { BankAccountDTO, ImportPreviewResponse } from "./types";
import { formatDate } from "@/lib/format";

interface Props {
  accounts: BankAccountDTO[];
  onClose: () => void;
  onImported: () => void;
}

type Preview = ImportPreviewResponse["preview"];

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
  inserted?: { statementImportId: string; rowsInserted: number };
};

type Stage = "select" | "review" | "importing" | "result";

let __fileIdSeq = 0;
const nextFileId = () => `f${++__fileIdSeq}`;

export function ImportModal({ accounts: _accounts, onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>("select");
  const [items, setItems] = useState<FileItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newItems: FileItem[] = arr.map((f) => ({
      id: nextFileId(),
      file: f,
      status: "previewing",
    }));
    setItems((prev) => [...prev, ...newItems]);
    setStage("review");
    for (const it of newItems) {
      void loadPreviewFor(it.id, it.file);
    }
  }

  async function loadPreviewFor(id: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/cartolas/import?dryRun=1", {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, status: "preview_error", error: data.error || "Error al procesar" }
              : it
          )
        );
        return;
      }
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, status: "previewed", preview: data.preview } : it
        )
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error de red";
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, status: "preview_error", error: msg } : it
        )
      );
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function retryPreview(id: string) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setItems((prev) =>
      prev.map((x) =>
        x.id === id ? { ...x, status: "previewing", error: undefined } : x
      )
    );
    void loadPreviewFor(id, it.file);
  }

  async function importAll() {
    const importable = items.filter(
      (it) => it.status === "previewed" && it.preview && !it.preview.alreadyImported
    );
    if (importable.length === 0) return;

    setStage("importing");
    let anyInserted = false;

    for (const it of importable) {
      setItems((prev) =>
        prev.map((x) => (x.id === it.id ? { ...x, status: "importing" } : x))
      );
      const fd = new FormData();
      fd.append("file", it.file);
      try {
        const res = await fetch("/api/cartolas/import", {
          method: "POST",
          body: fd,
        });
        const data = await res.json();
        if (!res.ok) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === it.id
                ? {
                    ...x,
                    status: "import_error",
                    error: data.error || "Error al importar",
                  }
                : x
            )
          );
          continue;
        }
        if (data.inserted?.rowsInserted > 0) anyInserted = true;
        setItems((prev) =>
          prev.map((x) =>
            x.id === it.id ? { ...x, status: "imported", inserted: data.inserted } : x
          )
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Error de red";
        setItems((prev) =>
          prev.map((x) =>
            x.id === it.id ? { ...x, status: "import_error", error: msg } : x
          )
        );
      }
    }

    setStage("result");
    if (anyInserted) onImported();
  }

  const previewing = items.filter((it) => it.status === "previewing").length;
  const importableItems = items.filter(
    (it) => it.status === "previewed" && it.preview && !it.preview.alreadyImported
  );
  const totalToInsert = importableItems.reduce(
    (acc, it) => acc + (it.preview?.totals.toInsert ?? 0),
    0
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Importar cartolas</h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {stage === "select" && (
          <SelectStage
            inputRef={inputRef}
            onSelect={(files) => addFiles(files)}
          />
        )}

        {(stage === "review" || stage === "importing") && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-text-muted">
                {items.length} archivo{items.length === 1 ? "" : "s"}
                {previewing > 0 && (
                  <span className="ml-2">· analizando {previewing}…</span>
                )}
              </div>
              {stage === "review" && (
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="btn-ghost text-sm"
                >
                  + Agregar más
                </button>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".xlsx,.xls"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="space-y-2">
              {items.map((it) => (
                <FileCard
                  key={it.id}
                  item={it}
                  onRemove={
                    stage === "review" ? () => removeItem(it.id) : undefined
                  }
                  onRetry={
                    stage === "review" && it.status === "preview_error"
                      ? () => retryPreview(it.id)
                      : undefined
                  }
                />
              ))}
            </div>

            {stage === "review" && (
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-soft">
                <button onClick={onClose} className="btn-ghost">
                  Cancelar
                </button>
                <button
                  onClick={importAll}
                  disabled={importableItems.length === 0 || previewing > 0}
                  className="btn-primary"
                >
                  {importableItems.length === 0
                    ? "Nada por importar"
                    : `Importar ${importableItems.length} archivo${
                        importableItems.length === 1 ? "" : "s"
                      } (${totalToInsert} movs)`}
                </button>
              </div>
            )}
          </div>
        )}

        {stage === "result" && <ResultStage items={items} onClose={onClose} />}
      </div>
    </div>
  );
}

function SelectStage({
  inputRef,
  onSelect,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  onSelect: (files: FileList) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        Selecciona uno o varios archivos de cartola (.xlsx o .xls). El sistema
        detectará el banco automáticamente para cada archivo.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        multiple
        className="input"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onSelect(e.target.files);
          }
        }}
      />
    </div>
  );
}

function FileCard({
  item,
  onRemove,
  onRetry,
}: {
  item: FileItem;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const { file, status, preview, error, inserted } = item;

  return (
    <div className="rounded-md border border-border-soft bg-bg-soft/40 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate" title={file.name}>
            {file.name}
          </div>
          <StatusLine item={item} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onRetry && (
            <button onClick={onRetry} className="btn-ghost text-xs">
              Reintentar
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              className="btn-ghost text-xs text-text-muted"
              title="Quitar de la lista"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {status === "preview_error" && error && (
        <div className="text-xs text-danger">{error}</div>
      )}
      {status === "import_error" && error && (
        <div className="text-xs text-danger">{error}</div>
      )}

      {preview && (
        <PreviewSummary preview={preview} status={status} inserted={inserted} />
      )}
    </div>
  );
}

function StatusLine({ item }: { item: FileItem }) {
  switch (item.status) {
    case "previewing":
      return <div className="text-xs text-text-muted">Analizando…</div>;
    case "preview_error":
      return <div className="text-xs text-danger">No se pudo procesar</div>;
    case "importing":
      return <div className="text-xs text-text-muted">Importando…</div>;
    case "imported":
      return (
        <div className="text-xs text-success">
          ✓ Importado · {item.inserted?.rowsInserted ?? 0} movimientos
        </div>
      );
    case "import_error":
      return <div className="text-xs text-danger">Falló la importación</div>;
    case "previewed": {
      const p = item.preview;
      if (!p) return null;
      if (p.alreadyImported) {
        return (
          <div className="text-xs text-warn">
            Ya importado el {formatDate(p.alreadyImported.importedAt)}
          </div>
        );
      }
      if (p.totals.toInsert === 0) {
        return (
          <div className="text-xs text-text-muted">
            Sin movimientos nuevos (todo es duplicado)
          </div>
        );
      }
      return (
        <div className="text-xs text-text-muted">
          {p.bankName} · {p.totals.toInsert} a insertar
        </div>
      );
    }
  }
}

function PreviewSummary({
  preview,
  status,
  inserted,
}: {
  preview: Preview;
  status: FileItem["status"];
  inserted?: { rowsInserted: number };
}) {
  const r = preview.resolvedAccount;
  const accountLabel = r.isUnassigned
    ? `${r.holderName} (${r.bankName})`
    : `${r.holderName} · ${r.displayNumber || r.accountNumber}`;

  const resolutionLabel: Record<string, string> = {
    DIRECT_MATCH: "match por número",
    FILENAME_MATCH: "match por nombre",
    ONLY_BANK_ACCOUNT: "única cuenta del banco",
    FALLBACK_UNASSIGNED: "sin asignar",
  };

  const periodStr =
    preview.periodFrom && preview.periodTo
      ? `${formatDate(preview.periodFrom)} → ${formatDate(preview.periodTo)}`
      : "—";

  const t = preview.totals;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
      <KV label="Banco" value={preview.bankName} />
      <KV label="Cuenta" value={accountLabel} sub={resolutionLabel[r.resolutionMethod]} />
      <KV label="Periodo" value={periodStr} />
      <KV
        label={status === "imported" ? "Insertados" : "A insertar"}
        value={String(status === "imported" ? inserted?.rowsInserted ?? 0 : t.toInsert)}
        highlight={
          status === "imported"
            ? "success"
            : t.toInsert > 0
            ? "success"
            : "muted"
        }
      />
      {(t.duplicatesSameAccount > 0 || t.duplicatesOtherAccount > 0) && (
        <KV
          label="Duplicados"
          value={String(t.duplicatesSameAccount + t.duplicatesOtherAccount)}
          sub={
            t.duplicatesOtherAccount > 0
              ? `${t.duplicatesOtherAccount} en otra cuenta`
              : undefined
          }
          highlight="muted"
        />
      )}
      {t.parseErrors > 0 && (
        <KV
          label="Filas con error"
          value={String(t.parseErrors)}
          highlight="danger"
        />
      )}
      {r.isUnassigned && (
        <div className="col-span-2 sm:col-span-4 text-xs text-warn">
          Cuenta no registrada
          {preview.unresolvedAccountInfo?.displayNumber
            ? ` (${preview.unresolvedAccountInfo.displayNumber})`
            : ""}
          . Los movimientos quedarán en <strong>{r.holderName}</strong>.
        </div>
      )}
    </div>
  );
}

function KV({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: "success" | "muted" | "danger";
}) {
  const cls =
    highlight === "success"
      ? "text-success"
      : highlight === "danger"
      ? "text-danger"
      : highlight === "muted"
      ? "text-text-muted"
      : "text-text";
  return (
    <div className="rounded-md bg-bg p-2 border border-border-soft">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className={`text-sm font-medium truncate ${cls}`} title={value}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-text-muted truncate">{sub}</div>}
    </div>
  );
}

function ResultStage({
  items,
  onClose,
}: {
  items: FileItem[];
  onClose: () => void;
}) {
  const imported = items.filter((it) => it.status === "imported");
  const failed = items.filter((it) => it.status === "import_error");
  const skipped = items.filter(
    (it) => it.status === "previewed" && it.preview?.alreadyImported
  );
  const totalInserted = imported.reduce(
    (acc, it) => acc + (it.inserted?.rowsInserted ?? 0),
    0
  );

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
        ✓ Se insertaron <strong>{totalInserted}</strong> movimientos nuevos en{" "}
        <strong>{imported.length}</strong> archivo
        {imported.length === 1 ? "" : "s"}.
      </div>

      {(failed.length > 0 || skipped.length > 0) && (
        <div className="text-xs text-text-muted">
          {failed.length > 0 && (
            <div className="text-danger">
              {failed.length} archivo{failed.length === 1 ? "" : "s"} con error.
            </div>
          )}
          {skipped.length > 0 && (
            <div>
              {skipped.length} archivo{skipped.length === 1 ? "" : "s"} ya estaban
              importados.
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        {items.map((it) => (
          <FileCard key={it.id} item={it} />
        ))}
      </div>

      <div className="flex justify-end pt-2">
        <button onClick={onClose} className="btn-primary">
          Cerrar
        </button>
      </div>
    </div>
  );
}
