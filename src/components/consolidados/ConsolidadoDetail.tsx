"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
  // Rubro banco para el asiento (override). Cross-banco: pre-elige el sugerido
  // de la cuenta real; si no, el rubroBanco que vino de la API.
  const [overrideRubro, setOverrideRubro] = useState<number | null>(null);
  // Buscador manual de contraparte (para movimientos sin candidato).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchExact, setSearchExact] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<
    Array<{
      id: string;
      postDate: string;
      amount: string;
      direction: string;
      description: string | null;
      counterpartyName: string | null;
      counterpartyRut: string | null;
      account: { bankName: string; holderName: string; displayNumber: string | null; accountNumber: string };
      consolidado: { id: string; status: string } | null;
    }>
  >([]);
  // Necesario para createPortal: document no existe durante SSR de Next.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/consolidados/${tesoreriaId}`);
      if (!res.ok) return;
      const d: DetailResponse = await res.json();
      setData(d);
      setNotesDraft(d.consolidado?.notes ?? "");
      setOverrideRubro(d.proposal?.suggestedRubro ?? d.tesoreria.rubroBanco ?? null);
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

  // Vincula manualmente N movimientos de banco a esta tesorería (→ MANUAL).
  // Sirve tanto para la propuesta del motor (1 o split) como para el buscador.
  async function linkBankMovements(bankMovementIds: string[]) {
    if (bankMovementIds.length === 0) return;
    setActing(true);
    try {
      const body: {
        tesoreriaId: string;
        bankMovementIds: string[];
        overrideRubroBanco?: number;
      } = { tesoreriaId, bankMovementIds };
      // Solo mandamos override si el operador eligió un rubro distinto al que
      // vino de la API (típico en cross-banco: el asiento va al banco real).
      if (overrideRubro != null && overrideRubro !== data?.tesoreria.rubroBanco) {
        body.overrideRubroBanco = overrideRubro;
      }
      const res = await fetch("/api/consolidados/manual-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        await load();
        onChanged();
      } else {
        alert(j?.error ?? j?.message ?? "No se pudo vincular");
      }
    } finally {
      setActing(false);
    }
  }

  async function runSearch() {
    if (!data) return;
    setSearching(true);
    try {
      const monto = BigInt(data.tesoreria.monto);
      const direction = monto < 0n ? "OUT" : "IN";
      const p = new URLSearchParams({ direction, limit: "50" });
      if (searchQ.trim()) p.set("q", searchQ.trim());
      if (searchExact) {
        p.set("minAmount", monto.toString());
        p.set("maxAmount", monto.toString());
      }
      const res = await fetch(`/api/bank-movements?${p}`);
      if (res.ok) {
        const j = await res.json();
        setSearchResults(j.movements ?? []);
      } else {
        setSearchResults([]);
      }
    } finally {
      setSearching(false);
    }
  }

  // Selector de rubro banco para el asiento (override). Se muestra antes de
  // vincular; cross-banco viene pre-elegido con el sugerido de la cuenta real.
  function renderRubroSelect() {
    if (!data) return null;
    const tmRubro = data.tesoreria.rubroBanco;
    const suggested = data.proposal?.suggestedRubro ?? null;
    const isCross = suggested != null && suggested !== tmRubro;
    return (
      <div className="rounded-md border border-border-soft bg-white p-2 text-xs mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-text-muted">Rubro banco (asiento):</span>
          <select
            value={overrideRubro ?? ""}
            onChange={(e) =>
              setOverrideRubro(e.target.value ? Number(e.target.value) : null)
            }
            className="rounded-md border border-border-soft px-2 py-1 text-xs"
          >
            {data.bankRubros.map((r) => (
              <option key={r.rubro} value={r.rubro}>
                {r.rubro} · {r.name}
              </option>
            ))}
          </select>
          {suggested != null && overrideRubro === suggested && (
            <span className="text-emerald-700">✓ sugerido para la cuenta real</span>
          )}
        </div>
        {isCross && (
          <div className="text-amber-700 mt-1">
            ⚠ La API mandó rubro {tmRubro ?? "—"} (banco que se tipeó), pero la
            cuenta real sugiere <strong>{suggested}</strong>. El asiento se
            contabilizará en el rubro elegido arriba.
          </div>
        )}
      </div>
    );
  }

  const status: ConsolidadoStatus = (data?.consolidado?.status ??
    "UNPROCESSED") as ConsolidadoStatus;

  // Candidatos en vivo, sin repetir los que ya están en la propuesta del motor.
  const proposalIdSet = new Set(data?.proposal?.bankMovementIds ?? []);
  const otherCandidates = (data?.candidates ?? []).filter(
    (c) => !proposalIdSet.has(c.bankMovementId),
  );
  // ¿Tiene sentido ofrecer vincular? (no para los ya conciliados ni anulados)
  const canLink = !["AUTO_MATCHED", "MANUAL", "ANULADO"].includes(status);
  const proposalLinkedElsewhere =
    data?.proposal?.movements.some((m) => m.linkedElsewhere) ?? false;

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Detalle Consolidado</h2>
            <div className="text-xs text-text-muted font-mono">
              #{data?.tesoreria.externalId ?? "—"}
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
          <div className="py-8 text-center text-text-muted text-sm">Cargando...</div>
        )}

        {!loading && data && (
          <>
            {/* Status chips */}
            <div className="flex items-center gap-2 flex-wrap mb-4">
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
                <span className="badge border-warn/40 bg-warn/10 text-warn">
                  Excepción API
                </span>
              )}
              {data.consolidado?.matchType === "ACCOUNT_MISMATCH" && (
                <span className="badge border-orange-400/60 bg-orange-50 text-orange-700">
                  ⚠ Banco distinto al asignado
                </span>
              )}
            </div>

            {/* Banner explicativo de excepcion de cuenta */}
            {data.consolidado?.matchType === "ACCOUNT_MISMATCH" && (
              <div className="rounded-md border border-orange-300 bg-orange-50 p-3 text-sm mb-4">
                <strong>Excepción de banco:</strong> la API de Tesorería asignó
                este movimiento a <strong>{data.tesoreria.banco}</strong>, pero el
                match real está en otra cuenta del mismo banco. Verificá manualmente
                si el match es correcto. Si lo es, podés confirmarlo desde acá.
              </div>
            )}

            {/* Datos Tesoreria */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Fecha" value={formatDateTime(data.tesoreria.fecha)} />
              <Field
                label="Monto"
                value={formatMoney(BigInt(data.tesoreria.monto))}
                highlight
              />
              <Field
                label="Sucursal"
                value={`${data.tesoreria.sucursalName ?? "—"} (#${data.tesoreria.sucursalId})`}
              />
              <Field
                label="Cajero"
                value={
                  data.tesoreria.cajeroName
                    ? `${data.tesoreria.cajeroName} (${data.tesoreria.cajeroUsername})`
                    : data.tesoreria.cajeroUsername
                }
              />
              <Field
                label="Cliente"
                value={
                  data.tesoreria.clienteName || data.tesoreria.clienteRut
                    ? `${data.tesoreria.clienteName ?? "—"}${
                        data.tesoreria.clienteRut ? ` · ${data.tesoreria.clienteRut}` : ""
                      }`
                    : "—"
                }
              />
              <Field label="Documento" value={data.tesoreria.tipoDocumento ?? "—"} />
              <Field
                label="Folio"
                value={data.tesoreria.folio === "0" ? "—" : data.tesoreria.folio}
                mono
              />
              <Field label="Banco" value={data.tesoreria.banco ?? "—"} />
              <Field label="Banco sucursal" value={data.tesoreria.bancoSucursal ?? "—"} />
              <Field
                label="Banco detectado"
                value={data.tesoreria.bancoDetectado ?? "—"}
              />
              <Field
                label="Rubro sucursal"
                value={data.tesoreria.rubroSucursal?.toString() ?? "—"}
              />
              <Field
                label="Rubro banco"
                value={data.tesoreria.rubroBanco?.toString() ?? "—"}
              />
            </div>

            {/* Glosa */}
            <div className="mt-4">
              <div className="text-xs text-text-muted mb-1">Glosa</div>
              <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm">
                {data.tesoreria.glosa || "—"}
              </div>
            </div>

            {/* Movimientos bancarios vinculados */}
            {data.consolidado && data.consolidado.links.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-bold text-brand mb-2">
                  Movimientos bancarios vinculados ({data.consolidado.links.length})
                </h3>
                <div className="space-y-2">
                  {data.consolidado.links.map((l) => (
                    <div
                      key={l.bankMovementId}
                      className="rounded-md border border-emerald-300 bg-emerald-50/50 p-3 text-sm"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold">
                            {l.account.bankName}
                            {l.account.holderName ? ` ${l.account.holderName}` : ""}
                          </div>
                          <div className="text-xs text-text-muted font-mono">
                            {l.account.displayNumber || l.account.accountNumber} ·{" "}
                            {formatDate(l.postDate)}
                          </div>
                        </div>
                        <div className="text-right font-mono font-bold whitespace-nowrap">
                          {formatMoney(BigInt(l.amount))}
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-text-muted break-words">
                        {l.description}
                      </div>
                      {l.counterpartyName && (
                        <div className="mt-1 text-xs">
                          <span className="font-semibold">Contraparte:</span>{" "}
                          {l.counterpartyName}
                          {l.counterpartyRut && ` (${l.counterpartyRut})`}
                        </div>
                      )}
                      <div className="mt-2">
                        <button
                          onClick={() => {
                            const msg =
                              status === "AUTO_MATCHED"
                                ? "Desvincular este match automático? El motor puede volver a matchearlo en la próxima corrida de \"Re-evaluar todo\"."
                                : "Desvincular este match? Volverá a estado NO_MATCH.";
                            if (confirm(msg)) action({ action: "reject" });
                          }}
                          disabled={acting}
                          className="text-xs text-rose-700 hover:underline disabled:opacity-50"
                        >
                          Desvincular
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Sugerencia del motor (propuesta persistida, incluye splits) */}
            {data.proposal && data.proposal.movements.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-bold text-brand mb-2">
                  Sugerencia del motor
                  {data.proposal.isSplit
                    ? ` · split de ${data.proposal.movements.length} movimientos`
                    : ""}
                </h3>
                <div className="rounded-md border border-brand/40 bg-brand/5 p-3 text-sm space-y-3">
                  {data.proposal.movements.map((m) => (
                    <div key={m.bankMovementId} className="border-b border-brand/10 pb-2 last:border-0 last:pb-0">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold">
                            {m.account.bankName} {m.account.holderName}{" "}
                            <span className="text-xs text-text-muted font-normal">
                              · {formatDate(m.postDate)}
                            </span>
                          </div>
                          <div className="text-[11px] text-text-muted font-mono mt-0.5">
                            {m.account.displayNumber || m.account.accountNumber}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5 break-words">
                            {m.description}
                          </div>
                          {m.counterpartyName && (
                            <div className="text-xs mt-1">
                              <span className="font-semibold">Contraparte:</span>{" "}
                              {m.counterpartyName}
                              {m.counterpartyRut && ` (${m.counterpartyRut})`}
                            </div>
                          )}
                          {m.factors.length > 0 && (
                            <div className="text-xs text-text-muted mt-2 flex flex-wrap gap-x-3 gap-y-0.5">
                              {m.factors.map((f, i) => (
                                <span key={i}>
                                  <span className={f.weight >= 0 ? "text-emerald-700 font-semibold" : "text-rose-700 font-semibold"}>
                                    {f.weight > 0 ? "+" : ""}{f.weight}
                                  </span>{" "}
                                  {f.label}
                                </span>
                              ))}
                            </div>
                          )}
                          {m.linkedElsewhere && (
                            <div className="text-xs text-warn mt-1">
                              ⚠ Este movimiento ya está vinculado a otro consolidado. Desvinculalo allá antes.
                            </div>
                          )}
                        </div>
                        <div className="text-right font-mono font-bold whitespace-nowrap">
                          {formatMoney(BigInt(m.amount))}
                        </div>
                      </div>
                    </div>
                  ))}
                  {canLink && renderRubroSelect()}
                  <div className="flex items-center justify-between pt-1">
                    <div className="text-xs text-text-muted">
                      Total propuesto:{" "}
                      <strong className="font-mono">{formatMoney(BigInt(data.proposal.totalAmount))}</strong>
                      {data.proposal.score != null && <> · Score {data.proposal.score}</>}
                    </div>
                    {canLink && (
                      <button
                        onClick={() => linkBankMovements(data.proposal!.bankMovementIds)}
                        disabled={acting || proposalLinkedElsewhere}
                        className="rounded-md bg-brand text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                        title={proposalLinkedElsewhere ? "Hay un movimiento ya vinculado a otro consolidado" : undefined}
                      >
                        {data.proposal.isSplit
                          ? `Vincular split (${data.proposal.movements.length})`
                          : "Vincular"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Candidatos en vivo (alternativas) */}
            {otherCandidates.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-bold text-brand mb-2">
                  {data.proposal ? "Otros candidatos" : "Candidatos bancarios"} ({otherCandidates.length})
                </h3>
                <div className="space-y-2">
                  {otherCandidates.map((c) => {
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
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold flex items-center gap-2 flex-wrap">
                              <span>
                                {c.account.bankName} {c.account.holderName}{" "}
                                <span className="text-xs text-text-muted font-normal">
                                  · {formatDate(c.postDate)}
                                </span>
                              </span>
                              {c.duplicateInCartola && (
                                <span
                                  className="badge border-warn/40 bg-warn/10 text-warn"
                                  title={`Hay ${c.duplicateCount} movimientos idénticos en BD (mismo monto, día y referencia). Limpialos desde Cartolas → Detectar duplicados.`}
                                >
                                  ⚠ duplicado x{c.duplicateCount} — limpiar
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-text-muted font-mono mt-0.5">
                              {c.account.displayNumber || c.account.accountNumber}
                            </div>
                            <div className="text-xs text-text-muted mt-0.5 break-words">
                              {c.description}
                            </div>
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
                                    <span
                                      className={
                                        f.weight >= 0
                                          ? "text-emerald-700 font-semibold"
                                          : "text-rose-700 font-semibold"
                                      }
                                    >
                                      {f.weight > 0 ? "+" : ""}
                                      {f.weight}
                                    </span>{" "}
                                    {f.label}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-mono font-bold whitespace-nowrap">
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
              </div>
            )}

            {/* Mensajes de estado vacío */}
            {data.consolidado?.status === "OUT_OF_SCOPE" && (
              <div className="mt-5 rounded-md border border-zinc-300 bg-zinc-50 p-3 text-sm">
                <strong>Fuera de scope:</strong>{" "}
                {data.consolidado.outOfScopeReason ?? "Sin razón especificada"}
              </div>
            )}
            {/* Sin propuesta del motor ni candidatos en vivo → explicar por qué
                y ofrecer el buscador manual. Cubre REVIEW (excepción/multipart),
                SUGGESTED cuyo candidato ya no aplica, y NO_MATCH. */}
            {canLink && !data.proposal && otherCandidates.length === 0 && (
              <div className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                El motor no encontró una contraparte automática (monto exacto en
                ±7 días en la cuenta resuelta). Suele pasar con depósitos a otro
                banco (excepción), pagos divididos (split) o cartola aún no
                cargada. Buscá el movimiento de banco manualmente abajo y
                vinculalo, o subí la cartola y volvé a "Re-evaluar todo".
              </div>
            )}

            {/* Buscador manual de contraparte */}
            {canLink && (
              <div className="mt-5">
                <button
                  onClick={() => {
                    setSearchOpen((v) => !v);
                    if (!searchOpen && searchResults.length === 0) void runSearch();
                  }}
                  className="text-sm font-semibold text-brand hover:underline"
                >
                  {searchOpen ? "▾" : "▸"} Buscar contraparte manualmente
                </button>
                {searchOpen && (
                  <div className="mt-2 rounded-md border border-border-soft bg-bg-soft/40 p-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && runSearch()}
                        placeholder="Glosa / contraparte / RUT…"
                        className="flex-1 min-w-[180px] rounded-md border border-border-soft px-3 py-1.5 text-sm"
                      />
                      <label className="flex items-center gap-1 text-xs text-text-muted">
                        <input
                          type="checkbox"
                          checked={searchExact}
                          onChange={(e) => setSearchExact(e.target.checked)}
                        />
                        Monto exacto
                      </label>
                      <button
                        onClick={() => runSearch()}
                        disabled={searching}
                        className="rounded-md bg-brand text-white text-xs font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
                      >
                        {searching ? "Buscando…" : "Buscar"}
                      </button>
                    </div>

                    {searchResults.length === 0 && !searching && (
                      <div className="text-xs text-text-muted">Sin resultados. Ajustá la búsqueda (probá destildar "Monto exacto").</div>
                    )}

                    {searchResults.length > 0 && renderRubroSelect()}

                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {searchResults.map((r) => {
                        const linked = !!r.consolidado;
                        return (
                          <div key={r.id} className="rounded-md border border-border-soft bg-white p-2 text-sm flex justify-between items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold">
                                {r.account.bankName} {r.account.holderName}{" "}
                                <span className="text-xs text-text-muted font-normal">· {formatDate(r.postDate)} · {r.direction}</span>
                              </div>
                              <div className="text-[11px] text-text-muted font-mono">
                                {r.account.displayNumber || r.account.accountNumber}
                              </div>
                              <div className="text-xs text-text-muted break-words">{r.description}</div>
                              {r.counterpartyName && (
                                <div className="text-xs mt-0.5">
                                  <span className="font-semibold">Contraparte:</span> {r.counterpartyName}
                                  {r.counterpartyRut && ` (${r.counterpartyRut})`}
                                </div>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono font-bold whitespace-nowrap">{formatMoney(BigInt(r.amount))}</div>
                              {linked ? (
                                <div className="text-[11px] text-text-muted mt-1">ya vinculado</div>
                              ) : (
                                <button
                                  onClick={() => linkBankMovements([r.id])}
                                  disabled={acting}
                                  className="mt-1 rounded-md bg-brand text-white text-xs font-semibold px-3 py-1 hover:opacity-90 disabled:opacity-50"
                                >
                                  Vincular
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Notas */}
            <div className="mt-5">
              <div className="text-xs text-text-muted mb-1">Notas</div>
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
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function Field({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-muted">{label}</div>
      <div
        className={`${mono ? "font-mono" : ""} text-sm ${
          highlight ? "font-bold text-brand" : ""
        } break-words`}
      >
        {value}
      </div>
    </div>
  );
}
