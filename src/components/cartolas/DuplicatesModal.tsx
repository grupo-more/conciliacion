"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatMoney } from "@/lib/format";

interface DuplicateMovement {
  id: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  externalId: string | null;
  isLinkedToConsolidado: boolean;
  statementImportId: string;
  createdAt: string;
}

interface DuplicateGroup {
  key: string;
  accountId: string;
  accountLabel: string;
  amount: string;
  postDate: string;
  reference: string;
  movements: DuplicateMovement[];
}

interface DuplicatesResponse {
  totalDuplicateGroups: number;
  totalDuplicateMovements: number;
  excessMovements: number;
  groups: DuplicateGroup[];
}

export function DuplicatesModal({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<DuplicatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selección de "el que se queda" por grupo
  const [keepByGroup, setKeepByGroup] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setMounted(true);
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cartolas/duplicates");
      if (!res.ok) {
        setError("Error al cargar duplicados");
        return;
      }
      const d: DuplicatesResponse = await res.json();
      setData(d);
      // Default: el más antiguo se queda (suele ser el más completo o el
      // primero que se importó). Es heurística, el usuario puede cambiarla.
      const defaults = new Map<string, string>();
      for (const g of d.groups) {
        // Preferir el que YA está vinculado a Consolidado, si hay alguno.
        const linked = g.movements.find((m) => m.isLinkedToConsolidado);
        if (linked) {
          defaults.set(g.key, linked.id);
        } else {
          // Sino, el de descripción más larga (suele ser el más completo)
          const longest = g.movements
            .slice()
            .sort((a, b) => b.description.length - a.description.length)[0];
          defaults.set(g.key, longest.id);
        }
      }
      setKeepByGroup(defaults);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function mergeGroup(group: DuplicateGroup) {
    const keepId = keepByGroup.get(group.key);
    if (!keepId) return;
    const removeIds = group.movements.filter((m) => m.id !== keepId).map((m) => m.id);
    if (removeIds.length === 0) return;

    setMerging(group.key);
    setError(null);
    try {
      const res = await fetch("/api/cartolas/duplicates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, removeIds }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "Error al fusionar");
        return;
      }
      await load();
    } finally {
      setMerging(null);
    }
  }

  async function mergeAll() {
    if (!data) return;
    if (
      !confirm(
        `Fusionar TODOS los ${data.groups.length} grupos? Para cada uno se queda el seleccionado en verde y se eliminan los demás.`
      )
    ) {
      return;
    }
    for (const g of data.groups) {
      await mergeGroup(g);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel max-w-5xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Detectar duplicados
            </h2>
            <div className="text-xs text-text-muted mt-0.5">
              Movimientos del banco que parecen ser el mismo (misma cuenta, fecha,
              monto y referencia embebida en la descripción) pero quedaron duplicados.
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading && (
          <div className="py-8 text-center text-text-muted text-sm">
            Buscando duplicados…
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-md border border-danger/40 bg-danger/10 p-2.5 text-sm text-danger">
            {error}
          </div>
        )}

        {!loading && data && data.groups.length === 0 && (
          <div className="py-10 text-center">
            <div className="text-3xl mb-2">✓</div>
            <div className="text-sm font-semibold text-success">
              No se detectaron duplicados.
            </div>
            <div className="text-xs text-text-muted mt-1">
              Todos los movimientos parecen únicos. Si en el futuro subís cartolas
              de distinto formato, el nuevo algoritmo de dedup va a detectarlos
              automáticamente.
            </div>
          </div>
        )}

        {!loading && data && data.groups.length > 0 && (
          <>
            <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm mb-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <strong>{data.totalDuplicateGroups}</strong> grupos detectados ·{" "}
                <strong>{data.totalDuplicateMovements}</strong> movimientos involucrados
                · {" "}
                <strong className="text-danger">{data.excessMovements}</strong> de más
                a eliminar
              </div>
              <button
                onClick={mergeAll}
                disabled={merging !== null}
                className="btn-primary text-xs"
              >
                Fusionar todos
              </button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
              {data.groups.map((g) => (
                <GroupCard
                  key={g.key}
                  group={g}
                  keepId={keepByGroup.get(g.key) ?? null}
                  setKeepId={(id) =>
                    setKeepByGroup((m) => new Map(m).set(g.key, id))
                  }
                  onMerge={() => mergeGroup(g)}
                  merging={merging === g.key}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function GroupCard({
  group,
  keepId,
  setKeepId,
  onMerge,
  merging,
}: {
  group: DuplicateGroup;
  keepId: string | null;
  setKeepId: (id: string) => void;
  onMerge: () => void;
  merging: boolean;
}) {
  return (
    <div className="rounded-md border border-border-soft bg-white p-3">
      <div className="flex justify-between items-start gap-2 mb-2">
        <div className="text-sm">
          <div className="font-semibold">
            {group.accountLabel}
          </div>
          <div className="text-xs text-text-muted">
            {formatDate(group.postDate)} · {formatMoney(BigInt(group.amount))} ·
            Ref. <span className="font-mono">{group.reference}</span>
          </div>
        </div>
        <button
          onClick={onMerge}
          disabled={merging || !keepId}
          className="btn-primary text-xs disabled:opacity-50"
        >
          {merging ? "Fusionando..." : "Fusionar este grupo"}
        </button>
      </div>

      <div className="text-[11px] text-text-muted mb-2">
        Selecciona cuál querés conservar (los otros se eliminan):
      </div>

      <div className="space-y-1.5">
        {group.movements.map((m) => {
          const isKeep = m.id === keepId;
          return (
            <label
              key={m.id}
              className={`flex items-start gap-2 rounded-md border p-2 text-xs cursor-pointer transition-all ${
                isKeep
                  ? "border-success bg-success/10"
                  : "border-border-soft bg-bg-soft/40 hover:bg-bg-soft"
              }`}
            >
              <input
                type="radio"
                name={`keep-${group.key}`}
                checked={isKeep}
                onChange={() => setKeepId(m.id)}
                className="mt-1 accent-success"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {isKeep && (
                    <span className="badge border-success/40 bg-success/10 text-success">
                      ✓ Se conserva
                    </span>
                  )}
                  {!isKeep && (
                    <span className="badge border-danger/40 bg-danger/10 text-danger">
                      Se elimina
                    </span>
                  )}
                  {m.isLinkedToConsolidado && (
                    <span className="badge border-brand/40 bg-brand/5 text-brand">
                      Vinculado a Consolidado
                    </span>
                  )}
                  <span className="text-text-muted">
                    Ext ID: <span className="font-mono">{m.externalId ?? "—"}</span>
                  </span>
                </div>
                <div className="mt-1 break-words">{m.description}</div>
                {m.counterpartyName && (
                  <div className="text-text-muted mt-0.5">
                    Contraparte: {m.counterpartyName}
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
