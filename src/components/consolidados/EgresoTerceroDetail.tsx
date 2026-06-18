"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatMoney } from "@/lib/format";

interface TesoreriaCand {
  tesoreriaId: string;
  externalId: string;
  fecha: string;
  monto: string;
  glosa: string;
  banco: string | null;
  bancoDetectado: string | null;
  clienteName: string | null;
  consolidadoStatus: string | null;
  proposedForThis: boolean;
}

interface DetailResp {
  bankMovement: {
    id: string;
    postDate: string;
    amount: string;
    description: string | null;
    counterpartyName: string | null;
    counterpartyRut: string | null;
    account: { bankName: string; holderName: string; displayNumber: string | null; accountNumber: string };
  };
  linked: {
    egresoMovementId: string;
    externalId: string;
    fecha: string;
    monto: string;
    glosa: string;
    rubroNombre: string | null;
    status: string | null;
  } | null;
  linkedTesoreria: {
    tesoreriaId: string;
    externalId: string;
    fecha: string;
    monto: string;
    glosa: string;
    banco: string | null;
    status: string;
  } | null;
  tesoreriaCandidates: TesoreriaCand[];
  tesoreriaSearch: TesoreriaCand[];
}

/** Detalle de un OUT a terceros para conciliarlo contra un gasto operativo. */
export function EgresoTerceroDetail({
  bankMovementId,
  onClose,
  onChanged,
}: {
  bankMovementId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DetailResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [q, setQ] = useState("");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  async function load(query = "") {
    setLoading(true);
    try {
      const p = query ? `?q=${encodeURIComponent(query)}` : "";
      const res = await fetch(`/api/consolidados/egresos-terceros/${bankMovementId}${p}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }
  // Búsqueda en tiempo real al tipear (debounce), sin apretar "Buscar".
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const h = setTimeout(() => void load(q), 300);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankMovementId]);

  // Vincula este OUT contra un movimiento de Tesorería (módulo principal),
  // resolviendo el cruce cross-banco sin salir de la tab.
  async function linkTesoreria(tesoreriaId: string) {
    setActing(true);
    try {
      const res = await fetch("/api/consolidados/manual-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tesoreriaId, bankMovementIds: [bankMovementId] }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        await load(q);
        onChanged();
      } else alert(j?.error ?? "No se pudo vincular con Tesorería");
    } finally {
      setActing(false);
    }
  }

  async function unlink() {
    setActing(true);
    try {
      const res = await fetch("/api/consolidados/egresos-terceros/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankMovementId, unlink: true }),
      });
      if (res.ok) {
        await load(q);
        onChanged();
      }
    } finally {
      setActing(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Egreso a tercero</h2>
          <button onClick={onClose} className="btn-ghost text-sm">✕</button>
        </div>

        {loading && !data && <p className="text-sm text-text-muted">Cargando…</p>}

        {data && (
          <>
            {/* Movimiento de banco */}
            <div className="rounded-md border border-border-soft bg-bg-soft/40 p-3 text-sm mb-4">
              <div className="flex justify-between">
                <div>
                  <div className="font-semibold">
                    {data.bankMovement.account.bankName} {data.bankMovement.account.holderName}
                    <span className="text-xs text-text-muted font-normal"> · {formatDate(data.bankMovement.postDate)}</span>
                  </div>
                  <div className="text-xs text-text-muted">{data.bankMovement.description}</div>
                  {data.bankMovement.counterpartyName && (
                    <div className="text-xs mt-0.5">
                      <span className="font-semibold">Contraparte:</span> {data.bankMovement.counterpartyName}
                      {data.bankMovement.counterpartyRut && ` (${data.bankMovement.counterpartyRut})`}
                    </div>
                  )}
                </div>
                <div className="font-mono font-bold text-rose-600">
                  {formatMoney(BigInt(data.bankMovement.amount))}
                </div>
              </div>
            </div>

            {/* Egreso vinculado */}
            {data.linked && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm mb-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold text-emerald-800">
                      Vinculado a gasto operativo ({data.linked.status})
                    </div>
                    <div className="text-xs mt-0.5">
                      {data.linked.rubroNombre ? `[${data.linked.rubroNombre}] ` : ""}{data.linked.glosa}
                    </div>
                    <div className="text-xs text-text-muted">
                      {formatDate(data.linked.fecha)} · {formatMoney(BigInt(data.linked.monto))}
                    </div>
                  </div>
                  <button onClick={unlink} disabled={acting} className="text-xs text-rose-700 hover:underline">
                    Desvincular
                  </button>
                </div>
              </div>
            )}

            {/* Ya conciliado contra Tesorería (módulo principal) */}
            {data.linkedTesoreria && (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm mb-4">
                <div className="font-semibold text-emerald-800">
                  Conciliado con Tesorería ({data.linkedTesoreria.status})
                </div>
                <div className="text-xs mt-0.5">
                  #{data.linkedTesoreria.externalId} · {data.linkedTesoreria.banco ?? "—"} · {data.linkedTesoreria.glosa}
                </div>
                <div className="text-xs text-text-muted">
                  {formatDate(data.linkedTesoreria.fecha)} · {formatMoney(BigInt(data.linkedTesoreria.monto))}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  Para desvincular, hacelo desde el módulo principal de Consolidados.
                </div>
              </div>
            )}

            {/* Candidatos: EGRESO de Dynatech del mismo monto en ±7 días */}
            {!data.linked && !data.linkedTesoreria && (
              <div className="mb-4">
                <h3 className="text-sm font-bold text-brand mb-2">
                  Egresos de Dynatech candidatos ({data.tesoreriaCandidates.length})
                </h3>
                {data.tesoreriaCandidates.length === 0 && (
                  <p className="text-xs text-text-muted">
                    No hay egresos de Dynatech del mismo monto en ±7 días. Buscá uno
                    por nombre o glosa abajo.
                  </p>
                )}
                <div className="space-y-2">
                  {data.tesoreriaCandidates.map((t) => (
                    <TesoreriaRow
                      key={t.tesoreriaId}
                      t={t}
                      acting={acting}
                      onLink={() => linkTesoreria(t.tesoreriaId)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Búsqueda manual sobre EGRESO de Dynatech (mismo monto, cualquier fecha) */}
            {!data.linked && !data.linkedTesoreria && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar egreso de Dynatech por glosa, cliente o RUT…"
                  className="flex-1 rounded-md border border-border-soft px-3 py-1.5 text-sm"
                />
                <span className="text-xs text-text-muted w-16">
                  {loading ? "Buscando…" : `${data.tesoreriaSearch.length} result.`}
                </span>
              </div>
              <p className="text-xs text-text-muted mb-2">
                Solo egresos del mismo monto ({formatMoney(BigInt(data.bankMovement.amount))}),
                para que la conciliación cuadre exacto.
              </p>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {data.tesoreriaSearch.map((t) => (
                  <TesoreriaRow
                    key={`s-${t.tesoreriaId}`}
                    t={t}
                    acting={acting}
                    onLink={() => linkTesoreria(t.tesoreriaId)}
                  />
                ))}
              </div>
            </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function TesoreriaRow({
  t,
  acting,
  onLink,
}: {
  t: TesoreriaCand;
  acting: boolean;
  onLink: () => void;
}) {
  return (
    <div className="rounded-md border border-border-soft bg-white p-2 text-sm flex justify-between items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          #{t.externalId} · {t.banco ?? t.bancoDetectado ?? "—"}
          {t.proposedForThis && (
            <span className="ml-2 inline-block rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 align-middle">
              Sugerido por el motor
            </span>
          )}
        </div>
        <div className="text-xs text-text-muted truncate" title={t.glosa}>
          {t.glosa}
        </div>
        <div className="text-xs text-text-muted">
          {formatDate(t.fecha)}
          {t.clienteName ? ` · ${t.clienteName}` : ""}
          {t.consolidadoStatus ? ` · ${t.consolidadoStatus}` : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono font-bold whitespace-nowrap">{formatMoney(BigInt(t.monto))}</div>
        <button
          onClick={onLink}
          disabled={acting}
          className="mt-1 rounded-md bg-brand text-white text-xs font-semibold px-3 py-1 hover:opacity-90 disabled:opacity-50"
        >
          Vincular
        </button>
      </div>
    </div>
  );
}
