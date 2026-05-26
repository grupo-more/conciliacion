"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate, formatDateTime } from "@/lib/format";
import {
  type DetailResponse,
  type ConsolidadoStatus,
  STATUS_COLORS,
  STATUS_LABELS,
} from "./types";

interface Props {
  tesoreriaId: string;
  onClose: () => void;
  onChanged: () => void;
}

export function ConsolidadoDetail({ tesoreriaId, onClose, onChanged }: Props) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/consolidados/${tesoreriaId}`);
      if (!res.ok) return;
      const d: DetailResponse = await res.json();
      setData(d);
      setNotesDraft(d.consolidado?.notes ?? "");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tesoreriaId]);

  async function action(payload: object) {
    setActing(true);
    try {
      const res = await fetch(`/api/consolidados/${tesoreriaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await load();
        onChanged();
      } else {
        const err = await res.json().catch(() => null);
        alert(err?.error ?? "Error en la acción");
      }
    } finally {
      setActing(false);
    }
  }

  const status: ConsolidadoStatus = (data?.consolidado?.status ??
    "UNPROCESSED") as ConsolidadoStatus;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-border-soft px-5 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-brand">Detalle Consolidado</h2>
            <div className="text-xs text-text-muted">
              ID Tesorería: {data?.tesoreria.externalId ?? "—"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xl hover:bg-bg-soft"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        {loading && <div className="p-8 text-center text-text-muted">Cargando...</div>}

        {!loading && data && (
          <div className="p-5 space-y-5">
            {/* Estado */}
            <div className="flex items-center gap-3">
              <span
                className={`inline-block rounded-full border px-3 py-1 text-sm font-bold ${STATUS_COLORS[status]}`}
              >
                {STATUS_LABELS[status]}
              </span>
              {data.consolidado?.score != null && (
                <span className="text-xs text-text-muted">
                  Score: <strong>{data.consolidado.score}</strong>
                </span>
              )}
              {data.consolidado?.matchType && (
                <span className="text-xs text-text-muted">
                  Tipo: <strong>{data.consolidado.matchType}</strong>
                </span>
              )}
              {data.tesoreria.esExcepcion && (
                <span className="rounded-full bg-amber-100 text-amber-800 text-xs px-2 py-0.5 font-bold border border-amber-200">
                  Excepción API
                </span>
              )}
            </div>

            {/* Datos Tesoreria */}
            <section>
              <h3 className="text-sm font-bold text-brand mb-2">Movimiento Tesorería</h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <Field label="Fecha" value={formatDateTime(data.tesoreria.fecha)} />
                <Field label="Monto" value={formatMoney(BigInt(data.tesoreria.monto))} mono />
                <Field
                  label="Sucursal"
                  value={`${data.tesoreria.sucursalName ?? "—"} (#${data.tesoreria.sucursalId})`}
                />
                <Field
                  label="Cajero"
                  value={data.tesoreria.cajeroName ?? data.tesoreria.cajeroUsername}
                />
                <Field
                  label="Cliente"
                  value={
                    data.tesoreria.clienteName
                      ? `${data.tesoreria.clienteName} ${data.tesoreria.clienteRut ? `(${data.tesoreria.clienteRut})` : ""}`
                      : "—"
                  }
                />
                <Field label="Documento" value={data.tesoreria.tipoDocumento ?? "—"} />
                <Field label="Folio" value={data.tesoreria.folio} mono />
                <Field label="Banco" value={data.tesoreria.banco ?? "—"} />
                <Field label="Banco sucursal" value={data.tesoreria.bancoSucursal ?? "—"} />
                <Field label="Banco detectado" value={data.tesoreria.bancoDetectado ?? "—"} />
                <Field label="Rubro sucursal" value={data.tesoreria.rubroSucursal?.toString() ?? "—"} />
                <Field label="Rubro banco" value={data.tesoreria.rubroBanco?.toString() ?? "—"} />
              </div>
              <div className="mt-3">
                <div className="text-xs text-text-muted mb-1">Glosa</div>
                <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm">
                  {data.tesoreria.glosa || "—"}
                </div>
              </div>
            </section>

            {/* Movimientos bancarios vinculados */}
            {data.consolidado && data.consolidado.links.length > 0 && (
              <section>
                <h3 className="text-sm font-bold text-brand mb-2">
                  Movimientos bancarios vinculados ({data.consolidado.links.length})
                </h3>
                <div className="space-y-2">
                  {data.consolidado.links.map((l) => (
                    <div
                      key={l.bankMovementId}
                      className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3 text-sm"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <div className="font-semibold">{l.account.bankName}</div>
                          <div className="text-xs text-text-muted">
                            {l.account.accountNumber} · {formatDate(l.postDate)}
                          </div>
                        </div>
                        <div className="text-right font-mono font-bold">
                          {formatMoney(BigInt(l.amount))}
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-text-muted">{l.description}</div>
                      {l.counterpartyName && (
                        <div className="mt-1 text-xs">
                          <span className="font-semibold">Contraparte:</span> {l.counterpartyName}
                          {l.counterpartyRut && ` (${l.counterpartyRut})`}
                        </div>
                      )}
                      {data.consolidado!.links.length > 0 && status !== "AUTO_MATCHED" && (
                        <div className="mt-2">
                          <button
                            onClick={() => action({ action: "reject" })}
                            disabled={acting}
                            className="text-xs text-rose-700 hover:underline disabled:opacity-50"
                          >
                            Desvincular
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Candidatos (para REVIEW / SUGGESTED / NO_MATCH) */}
            {data.candidates && data.candidates.length > 0 && (
              <section>
                <h3 className="text-sm font-bold text-brand mb-2">
                  Candidatos bancarios ({data.candidates.length})
                </h3>
                <div className="space-y-2">
                  {data.candidates.map((c) => {
                    const isLinked = data.consolidado?.links.some(
                      (l) => l.bankMovementId === c.bankMovementId
                    );
                    return (
                      <div
                        key={c.bankMovementId}
                        className={`rounded-md border p-3 text-sm ${
                          isLinked
                            ? "border-emerald-300 bg-emerald-50"
                            : "border-border-soft bg-white hover:bg-bg-soft"
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="flex-1">
                            <div className="font-semibold">
                              {c.account.bankName}{" "}
                              <span className="text-xs text-text-muted font-normal">
                                · {formatDate(c.postDate)}
                              </span>
                            </div>
                            <div className="text-xs text-text-muted mt-0.5">{c.description}</div>
                            {c.counterpartyName && (
                              <div className="text-xs mt-1">
                                <span className="font-semibold">Contraparte:</span>{" "}
                                {c.counterpartyName}
                                {c.counterpartyRut && ` (${c.counterpartyRut})`}
                              </div>
                            )}
                            {c.factors.length > 0 && (
                              <div className="text-xs text-text-muted mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
                                {c.factors.map((f, i) => (
                                  <span key={i}>
                                    <span className={f.weight >= 0 ? "text-emerald-700" : "text-rose-700"}>
                                      {f.weight > 0 ? "+" : ""}{f.weight}
                                    </span>{" "}
                                    {f.label}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono font-bold">
                              {formatMoney(BigInt(c.amount))}
                            </div>
                            <div className="text-xs mt-1">
                              Score: <strong>{c.score}</strong>
                            </div>
                            {!isLinked && (
                              <button
                                onClick={() =>
                                  action({
                                    action: "confirm",
                                    bankMovementId: c.bankMovementId,
                                  })
                                }
                                disabled={acting}
                                className="mt-2 rounded-md bg-brand text-white text-xs font-semibold px-3 py-1 hover:opacity-90 disabled:opacity-50"
                              >
                                Vincular
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Estado sin candidatos */}
            {data.consolidado?.status === "OUT_OF_SCOPE" && (
              <div className="rounded-md border border-zinc-300 bg-zinc-50 p-3 text-sm">
                <strong>Fuera de scope:</strong>{" "}
                {data.consolidado.outOfScopeReason ?? "Sin razón especificada"}
              </div>
            )}
            {data.consolidado?.status === "NO_MATCH" &&
              (!data.candidates || data.candidates.length === 0) && (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm">
                  Sin candidatos en la cuenta bancaria resuelta dentro de la ventana ±7 días.
                  Si la cartola correspondiente no se ha cargado todavía, súbela y vuelve a
                  procesar.
                </div>
              )}

            {/* Notas */}
            <section>
              <h3 className="text-sm font-bold text-brand mb-2">Notas</h3>
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-border-soft px-3 py-2 text-sm"
                placeholder="Comentarios para el equipo..."
              />
              <button
                onClick={() => action({ action: "notes", notes: notesDraft })}
                disabled={acting}
                className="mt-2 rounded-md border border-border-soft px-3 py-1 text-xs hover:bg-bg-soft disabled:opacity-50"
              >
                Guardar notas
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={mono ? "font-mono text-sm" : "text-sm"}>{value}</div>
    </div>
  );
}
