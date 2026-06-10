"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatMoney } from "@/lib/format";

interface EgresoCand {
  egresoMovementId: string;
  externalId: string;
  fecha: string;
  monto: string;
  glosa: string;
  rubroNombre: string | null;
  sucursalName: string | null;
  score: number;
  factors: Array<{ key: string; label: string; weight: number }>;
  alreadyLinkedHere: boolean;
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
  candidates: EgresoCand[];
  search: EgresoCand[];
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

  async function link(egresoMovementId: string) {
    setActing(true);
    try {
      const res = await fetch("/api/consolidados/egresos-terceros/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankMovementId, egresoMovementId }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        await load(q);
        onChanged();
      } else alert(j?.error ?? "No se pudo vincular");
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

            {/* Candidatos por monto */}
            {!data.linked && (
              <div className="mb-4">
                <h3 className="text-sm font-bold text-brand mb-2">
                  Gastos operativos candidatos ({data.candidates.length})
                </h3>
                {data.candidates.length === 0 && (
                  <p className="text-xs text-text-muted">
                    No hay gastos operativos del mismo monto en ±7 días. Buscá manualmente abajo.
                  </p>
                )}
                <div className="space-y-2">
                  {data.candidates.map((c) => (
                    <CandRow key={c.egresoMovementId} c={c} acting={acting} onLink={() => link(c.egresoMovementId)} />
                  ))}
                </div>
              </div>
            )}

            {/* Búsqueda manual */}
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar gasto operativo por glosa…"
                  className="flex-1 rounded-md border border-border-soft px-3 py-1.5 text-sm"
                />
                <span className="text-xs text-text-muted w-16">
                  {loading ? "Buscando…" : `${data.search.length} result.`}
                </span>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {data.search.map((c) => (
                  <CandRow key={`s-${c.egresoMovementId}`} c={c} acting={acting} onLink={() => link(c.egresoMovementId)} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CandRow({ c, acting, onLink }: { c: EgresoCand; acting: boolean; onLink: () => void }) {
  return (
    <div className="rounded-md border border-border-soft bg-white p-2 text-sm flex justify-between items-start gap-2">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">
          {c.rubroNombre ? `[${c.rubroNombre}] ` : ""}{c.glosa}
        </div>
        <div className="text-xs text-text-muted">
          {formatDate(c.fecha)} · {c.sucursalName ?? ""}
        </div>
        {c.factors.length > 0 && (
          <div className="text-xs text-text-muted mt-1 flex flex-wrap gap-x-3">
            {c.factors.map((f, i) => (
              <span key={i}>
                <span className={f.weight >= 0 ? "text-emerald-700 font-semibold" : "text-rose-700 font-semibold"}>
                  {f.weight > 0 ? "+" : ""}{f.weight}
                </span>{" "}
                {f.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono font-bold whitespace-nowrap">{formatMoney(BigInt(c.monto))}</div>
        <div className="text-xs">Score {c.score}</div>
        <button onClick={onLink} disabled={acting} className="mt-1 rounded-md bg-brand text-white text-xs font-semibold px-3 py-1 hover:opacity-90 disabled:opacity-50">
          Vincular
        </button>
      </div>
    </div>
  );
}
