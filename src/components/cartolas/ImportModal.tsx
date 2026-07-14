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

/**
 * Resolucion explicita elegida por el operador cuando la cartola no matchea
 * ninguna cuenta registrada.
 *
 *   pending      → todavia no eligio que hacer (bloquea el boton Importar)
 *   create-new   → va a crear una cuenta nueva con los datos del parser
 *                  (forceAccountId queda set despues de la creacion)
 *   assign       → va a asignar a una cuenta existente (forceAccountId set)
 *   leave-unset  → dejarlo en "Sin asignar" (sin forceAccountId)
 */
type ResolutionChoice =
  | { kind: "pending" }
  | { kind: "create-new"; accountId?: string }
  | { kind: "assign"; accountId: string }
  | { kind: "leave-unset" };

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
  /** Solo aplica cuando preview cae en FALLBACK_UNASSIGNED y el archivo no es duplicado. */
  resolution?: ResolutionChoice;
  /** forceAccountId resuelto que se envia al endpoint de import. */
  forceAccountId?: string;
};

type Stage = "select" | "review" | "importing" | "result";

let __fileIdSeq = 0;
const nextFileId = () => `f${++__fileIdSeq}`;

/**
 * Indica si un item esta "esperando resolucion del operador" — esto es: el
 * parser entrego cuenta no registrada Y no es un archivo ya importado. En
 * ese caso el operador debe decidir entre: crear nueva, asignar a existente,
 * o dejar en sin asignar.
 */
function needsResolution(it: FileItem): boolean {
  if (it.status !== "previewed") return false;
  const p = it.preview;
  if (!p) return false;
  if (p.alreadyImported) return false;
  return p.resolvedAccount.resolutionMethod === "FALLBACK_UNASSIGNED";
}

function isResolved(it: FileItem): boolean {
  if (!needsResolution(it)) return true;
  const r = it.resolution;
  if (!r || r.kind === "pending") return false;
  if (r.kind === "create-new" && !r.accountId) return false;
  if (r.kind === "assign" && !r.accountId) return false;
  return true;
}

export function ImportModal({ accounts, onClose, onImported }: Props) {
  const [stage, setStage] = useState<Stage>("select");
  const [items, setItems] = useState<FileItem[]>([]);
  const [accountsList, setAccountsList] = useState<BankAccountDTO[]>(accounts);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refrescar el listado de cuentas cuando se crea una desde el modal — para
  // que el dropdown "Asignar a existente" del siguiente archivo ya la incluya.
  async function refreshAccounts() {
    try {
      const res = await fetch("/api/bank-accounts");
      if (!res.ok) return;
      const data = await res.json();
      setAccountsList(data.accounts ?? []);
    } catch {
      /* noop */
    }
  }

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
        prev.map((it) => {
          if (it.id !== id) return it;
          const p = data.preview as Preview;
          const next: FileItem = { ...it, status: "previewed", preview: p };
          // Si la resolucion cayo en placeholder y NO es duplicado, marcamos
          // el item como pendiente de decision del operador.
          if (
            p.resolvedAccount.resolutionMethod === "FALLBACK_UNASSIGNED" &&
            !p.alreadyImported
          ) {
            next.resolution = { kind: "pending" };
          }
          return next;
        }),
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
      (it) => it.status === "previewed" && it.preview && it.preview.totals.toInsert > 0
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
      if (it.forceAccountId) {
        fd.append("forceAccountId", it.forceAccountId);
      }
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
    (it) => it.status === "previewed" && it.preview && it.preview.totals.toInsert > 0
  );
  const totalToInsert = importableItems.reduce(
    (acc, it) => acc + (it.preview?.totals.toInsert ?? 0),
    0
  );
  // Items que estan esperando que el operador decida que hacer (no se puede
  // importar mientras alguno este pendiente — fuerza decision explicita).
  const unresolvedCount = importableItems.filter(
    (it) => needsResolution(it) && !isResolved(it),
  ).length;

  // Setters de resolucion expuestos a las FileCard hijas.
  function updateResolution(id: string, resolution: ResolutionChoice) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const forceAccountId =
          resolution.kind === "create-new" || resolution.kind === "assign"
            ? resolution.accountId
            : undefined;
        return { ...it, resolution, forceAccountId };
      }),
    );
  }

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
                accept=".xlsx,.xls,.pdf"
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
                  accounts={accountsList}
                  onRemove={
                    stage === "review" ? () => removeItem(it.id) : undefined
                  }
                  onRetry={
                    stage === "review" && it.status === "preview_error"
                      ? () => retryPreview(it.id)
                      : undefined
                  }
                  onResolution={
                    stage === "review"
                      ? (r) => updateResolution(it.id, r)
                      : undefined
                  }
                  onAccountCreated={refreshAccounts}
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
                  disabled={
                    importableItems.length === 0 ||
                    previewing > 0 ||
                    unresolvedCount > 0
                  }
                  className="btn-primary"
                  title={
                    unresolvedCount > 0
                      ? `Hay ${unresolvedCount} archivo(s) con cuenta no resuelta — elegí qué hacer con cada uno.`
                      : undefined
                  }
                >
                  {importableItems.length === 0
                    ? "Nada por importar"
                    : unresolvedCount > 0
                      ? `Resolvé ${unresolvedCount} cuenta${unresolvedCount === 1 ? "" : "s"} primero`
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
        Selecciona uno o varios archivos de cartola (.xlsx, .xls o .pdf). El
        sistema detectará el banco automáticamente para cada archivo.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.pdf"
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
  accounts = [],
  onRemove,
  onRetry,
  onResolution,
  onAccountCreated,
}: {
  item: FileItem;
  accounts?: BankAccountDTO[];
  onRemove?: () => void;
  onRetry?: () => void;
  onResolution?: (r: ResolutionChoice) => void;
  onAccountCreated?: () => void;
}) {
  const { file, status, preview, error, inserted } = item;
  const showResolution = onResolution && needsResolution(item);

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

      {showResolution && preview && (
        <ResolutionBlock
          preview={preview}
          accounts={accounts}
          resolution={item.resolution ?? { kind: "pending" }}
          onResolution={onResolution!}
          onAccountCreated={onAccountCreated}
        />
      )}
    </div>
  );
}

/* ============================ Resolution block ============================ */

function ResolutionBlock({
  preview,
  accounts,
  resolution,
  onResolution,
  onAccountCreated,
}: {
  preview: Preview;
  accounts: BankAccountDTO[];
  resolution: ResolutionChoice;
  onResolution: (r: ResolutionChoice) => void;
  onAccountCreated?: () => void;
}) {
  const info = preview.unresolvedAccountInfo;
  const sug = preview.entidadSuggestion ?? null;

  return (
    <div className="rounded-md border border-warn/30 bg-warn/[0.04] p-3 space-y-2 text-sm">
      <div className="font-semibold text-warn">
        ⚠ Cuenta no encontrada en el sistema
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-text-muted">
        <div>
          <span className="block text-[10px] uppercase">Banco</span>
          <span className="text-text font-medium">{preview.bankName}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase">Nº cuenta</span>
          <span className="text-text font-mono">
            {info?.displayNumber || info?.accountNumber || "—"}
          </span>
        </div>
        <div>
          <span className="block text-[10px] uppercase">Titular</span>
          <span className="text-text font-medium">{info?.holderName || "—"}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase">RUT (cartola)</span>
          <span className="text-text font-mono">{info?.holderRut || "—"}</span>
        </div>
      </div>

      <div className="text-xs text-text-muted pt-2 border-t border-warn/20">
        ¿Qué hacés con estos movimientos?
      </div>

      <div className="space-y-2">
        <ResolutionOption
          label="Crear cuenta nueva con estos datos"
          selected={resolution.kind === "create-new"}
          onSelect={() => onResolution({ kind: "create-new" })}
        >
          {resolution.kind === "create-new" && (
            <CreateAccountForm
              preview={preview}
              suggestion={sug}
              onCreated={(accountId) => {
                onResolution({ kind: "create-new", accountId });
                onAccountCreated?.();
              }}
            />
          )}
        </ResolutionOption>

        <ResolutionOption
          label="Asignar a una cuenta existente"
          selected={resolution.kind === "assign"}
          onSelect={() => {
            // Default al primer account del mismo banco
            const sameBank = accounts.filter(
              (a) =>
                a.bankCode === preview.bankCode &&
                !a.isUnassigned,
            );
            onResolution({
              kind: "assign",
              accountId: sameBank[0]?.id ?? "",
            });
          }}
        >
          {resolution.kind === "assign" && (
            <AssignExistingForm
              bankCode={preview.bankCode}
              accounts={accounts}
              selectedId={resolution.accountId}
              onChange={(accountId) =>
                onResolution({ kind: "assign", accountId })
              }
            />
          )}
        </ResolutionOption>

        <ResolutionOption
          label='Dejar en "Sin asignar" (revisar después)'
          selected={resolution.kind === "leave-unset"}
          onSelect={() => onResolution({ kind: "leave-unset" })}
        />
      </div>
    </div>
  );
}

function ResolutionOption({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border p-2 ${
        selected
          ? "border-brand bg-brand/5"
          : "border-border-soft bg-bg hover:bg-bg-soft/60"
      }`}
    >
      <label className="flex items-center gap-2 cursor-pointer text-sm">
        <input
          type="radio"
          checked={selected}
          onChange={onSelect}
          className="cursor-pointer"
        />
        <span>{label}</span>
      </label>
      {children && <div className="pl-6 pt-2">{children}</div>}
    </div>
  );
}

function CreateAccountForm({
  preview,
  suggestion,
  onCreated,
}: {
  preview: Preview;
  suggestion: Preview["entidadSuggestion"];
  onCreated: (accountId: string) => void;
}) {
  const info = preview.unresolvedAccountInfo;
  const [holderName, setHolderName] = useState(info?.holderName ?? "");
  const [holderRut, setHolderRut] = useState(
    info?.holderRut ?? suggestion?.match?.rutCanonico ?? "",
  );
  const [alias, setAlias] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Indica si el RUT mostrado viene sugerido por el match con EntidadInterna
  // (no estaba en la cartola). En ese caso lo mostramos como banner.
  const rutFromSuggestion =
    !info?.holderRut && !!suggestion?.match?.rutCanonico;

  async function submit() {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/bank-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankCode: preview.bankCode,
          bankName: preview.bankName,
          accountNumber: info?.accountNumber ?? "",
          displayNumber: info?.displayNumber ?? null,
          holderName: holderName.trim(),
          holderRut: holderRut.trim() || null,
          alias: alias.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "No se pudo crear la cuenta.");
        return;
      }
      setCreatedId(data.id);
      onCreated(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de red");
    } finally {
      setCreating(false);
    }
  }

  if (createdId) {
    return (
      <div className="text-xs text-success">
        ✓ Cuenta creada. Los movimientos se asociarán a ella al importar.
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs">
      {rutFromSuggestion && suggestion?.match && (
        <div className="rounded border border-emerald-300 bg-emerald-50 text-emerald-800 px-2 py-1.5">
          💡 Sugerencia: el nombre del titular coincide con la entidad interna{" "}
          <strong>{suggestion.match.nombreCanonico}</strong>. Si confirmás,
          la cuenta se crea con RUT <span className="font-mono">{suggestion.match.rutCanonico}</span>{" "}
          y queda lista para Traspasos internos.
        </div>
      )}
      {suggestion?.reason === "ambiguous" && (
        <div className="rounded border border-amber-300 bg-amber-50 text-amber-800 px-2 py-1.5">
          ⚠ El titular matchea varias entidades:{" "}
          {suggestion.candidates.map((c) => c.nombreCanonico).join(", ")}.
          Confirmá el RUT manualmente.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-0.5">
          <span className="block text-[10px] uppercase text-text-muted">
            Titular
          </span>
          <input
            type="text"
            value={holderName}
            onChange={(e) => setHolderName(e.target.value)}
            className="input text-xs"
            required
          />
        </label>
        <label className="space-y-0.5">
          <span className="block text-[10px] uppercase text-text-muted">
            RUT
          </span>
          <input
            type="text"
            value={holderRut}
            onChange={(e) => setHolderRut(e.target.value)}
            className="input text-xs font-mono"
            placeholder="77.333.097-2"
          />
        </label>
      </div>
      <label className="space-y-0.5">
        <span className="block text-[10px] uppercase text-text-muted">
          Alias (opcional)
        </span>
        <input
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          className="input text-xs"
          placeholder="ej: MP More Exchange"
        />
      </label>

      {error && (
        <div className="text-danger text-xs">{error}</div>
      )}

      <button
        onClick={submit}
        disabled={creating || !holderName.trim()}
        className="btn-primary text-xs"
      >
        {creating ? "Creando…" : "Crear cuenta"}
      </button>
    </div>
  );
}

function AssignExistingForm({
  bankCode,
  accounts,
  selectedId,
  onChange,
}: {
  bankCode: string;
  accounts: BankAccountDTO[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  const candidates = accounts.filter(
    (a) => a.bankCode === bankCode && !a.isUnassigned,
  );

  if (candidates.length === 0) {
    return (
      <div className="text-xs text-text-muted">
        No hay cuentas registradas para {bankCode}. Usá "Crear cuenta nueva"
        o dejá en "Sin asignar".
      </div>
    );
  }

  return (
    <select
      value={selectedId}
      onChange={(e) => onChange(e.target.value)}
      className="input text-xs"
    >
      <option value="">— Elegí una cuenta —</option>
      {candidates.map((a) => (
        <option key={a.id} value={a.id}>
          {a.holderName} · {a.displayNumber || a.accountNumber}
        </option>
      ))}
    </select>
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
            {p.totals.toInsert > 0 && (
              <> · {p.totals.toInsert} nuevo{p.totals.toInsert === 1 ? "" : "s"} por agregar</>
            )}
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
