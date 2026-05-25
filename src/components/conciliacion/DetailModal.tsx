"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  BankLinkDTO,
  CandidateScoreDTO,
  ReconciliationDetailDTO,
} from "./types";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";

type CandidateItem = BankLinkDTO & { isLinked: boolean; score: CandidateScoreDTO | null };

interface Props {
  reconciliationId: string;
  onClose: () => void;
  onChanged: () => void;
}

export function DetailModal({ reconciliationId, onClose, onChanged }: Props) {
  const [data, setData] = useState<ReconciliationDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selección actual del usuario en la lista de candidatos
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/reconciliation/${reconciliationId}`);
      if (!res.ok) {
        setError("No se pudo cargar");
        return;
      }
      const j: ReconciliationDetailDTO = await res.json();
      setData(j);
      // Pre-seleccionar los que ya están linkeados
      setSelected(new Set(j.banks.map((b) => b.id)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciliationId]);

  async function callAction(body: object) {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/reconciliation/${reconciliationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j.error || "Error en la acción");
        return;
      }
      onChanged();
      onClose();
    } finally {
      setWorking(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // Suma de los seleccionados
  const selectedSum = useMemo(() => {
    if (!data) return 0;
    return data.candidates
      .filter((c) => selected.has(c.id))
      .reduce((acc, c) => acc + Number(c.amount), 0);
  }, [data, selected]);

  const totalDyn = data ? Number(data.dynatech.totalAmount) : 0;
  const sumMatches = totalDyn === selectedSum;
  const currentLinkedIds = useMemo(
    () => new Set(data?.banks.map((b) => b.id) ?? []),
    [data]
  );

  // ¿La selección es distinta a lo que ya está linkeado?
  const selectionChanged = useMemo(() => {
    if (!data) return false;
    if (selected.size !== currentLinkedIds.size) return true;
    for (const id of selected) {
      if (!currentLinkedIds.has(id)) return true;
    }
    return false;
  }, [selected, currentLinkedIds, data]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 sticky top-0 -mx-5 -mt-5 px-5 pt-5 pb-3 bg-white/95 backdrop-blur-md border-b border-border-soft z-10">
          <h2 className="text-lg font-semibold tracking-tight">Detalle de conciliación</h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {loading && <div className="py-8 text-center text-text-muted">Cargando…</div>}
        {error && <div className="text-danger text-sm mb-3">{error}</div>}

        {data && (
          <>
            <DynatechCard d={data.dynatech} status={data.status} />

            {/* Items del Dynatech */}
            {data.dynatech.items.length > 0 && (
              <div className="mt-3">
                <div className="text-xs text-text-muted mb-1">Items</div>
                <div className="rounded-md border border-border-soft overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-bg-soft text-text-muted">
                      <tr>
                        <th className="px-3 py-1.5 text-left">Operación</th>
                        <th className="px-3 py-1.5 text-right">Cantidad</th>
                        <th className="px-3 py-1.5 text-right">Tasa</th>
                        <th className="px-3 py-1.5 text-right">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.dynatech.items.map((it, idx) => (
                        <tr key={idx} className="border-t border-border-soft">
                          <td className="px-3 py-1.5">{it.nombre}</td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {it.cantidad.toLocaleString("es-CL", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {it.precioUnitario.toLocaleString("es-CL", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono">
                            {formatMoney(Math.round(it.monto))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Glosa parser */}
            <GlosaCard glosa={data.dynatech.glosa} />

            {/* Lista de candidatos: separados en match exacto vs partes para split */}
            <CandidatesList
              candidates={data.candidates}
              customerRut={data.dynatech.customerRut}
              customerName={data.dynatech.customerName}
              totalAmount={totalDyn}
              selected={selected}
              onToggle={toggle}
              selectedSum={selectedSum}
              sumMatches={sumMatches}
            />

            {/* Acciones */}
            <div className="mt-5 pt-4 border-t border-border-soft flex flex-wrap gap-2 justify-end">
              {selectionChanged && selected.size > 0 && (
                <button
                  onClick={() =>
                    callAction({
                      action: "manual",
                      bankMovementIds: Array.from(selected),
                    })
                  }
                  disabled={working || !sumMatches}
                  className="btn-primary"
                  title={
                    !sumMatches
                      ? "La suma de seleccionados debe ser igual al monto Dynatech"
                      : ""
                  }
                >
                  {sumMatches
                    ? `Conciliar con ${selected.size} ${selected.size === 1 ? "movimiento" : "movimientos"}`
                    : "Suma no coincide"}
                </button>
              )}
              {!selectionChanged && data.status === "SUGGESTED" && data.banks.length > 0 && (
                <button
                  onClick={() => callAction({ action: "approve" })}
                  disabled={working}
                  className="btn-primary"
                >
                  Aprobar match
                </button>
              )}
              {data.banks.length > 0 && (
                <button
                  onClick={() => callAction({ action: "unmatch" })}
                  disabled={working}
                  className="btn-ghost"
                >
                  Deshacer match
                </button>
              )}
              {data.status !== "OUT_OF_SCOPE" && (
                <button
                  onClick={() =>
                    callAction({ action: "out_of_scope", reason: "Marcado manualmente" })
                  }
                  disabled={working}
                  className="btn-ghost"
                >
                  Marcar fuera de scope
                </button>
              )}
              {data.status === "OUT_OF_SCOPE" && (
                <button
                  onClick={() => callAction({ action: "no_match" })}
                  disabled={working}
                  className="btn-ghost"
                >
                  Quitar fuera de scope
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DynatechCard({
  d,
  status,
}: {
  d: ReconciliationDetailDTO["dynatech"];
  status: string;
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-brand-tint/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-text-muted">Movimiento Dynatech</div>
          <div className="text-sm">
            {d.branchExternalName} · {d.cashierName || d.cashierUsername} ·{" "}
            {formatDateTime(d.occurredAt)}
          </div>
          {d.customerRut && (
            <div className="text-xs mt-1">
              Cliente: <span className="font-medium">{d.customerName ?? "—"}</span>
              <span className="text-text-muted font-mono ml-1.5">[{d.customerRut}]</span>
            </div>
          )}
          <div className="text-text font-medium mt-1">
            {formatMoney(Number(d.totalAmount))}
          </div>
          <div className="text-xs text-text-muted mt-1 truncate" title={d.observation}>
            "{d.observation}"
          </div>
        </div>
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

function GlosaCard({
  glosa,
}: {
  glosa: ReconciliationDetailDTO["dynatech"]["glosa"];
}) {
  const qualityColors: Record<string, string> = {
    EXCELLENT: "border-success/40 text-success bg-success/10",
    GOOD: "border-accent/40 text-accent bg-accent/10",
    FAIR: "border-warn/40 text-warn bg-warn/10",
    POOR: "border-danger/40 text-danger bg-danger/10",
  };
  const qualityLabel: Record<string, string> = {
    EXCELLENT: "Excelente",
    GOOD: "Buena",
    FAIR: "Regular",
    POOR: "Pobre",
  };

  const tags: string[] = [];
  if (glosa.bank) tags.push(`Banco: ${glosa.bank}`);
  if (glosa.unregisteredBank) tags.push(`Banco no reg.: ${glosa.unregisteredBank}`);
  if (glosa.holder) tags.push(`Empresa: ${glosa.holder}`);
  if (glosa.rut) tags.push(`RUT: ${glosa.rut}`);
  if (glosa.giroNumber) tags.push(`Giro #${glosa.giroNumber}`);

  return (
    <div className="mt-3 rounded-lg border border-border-soft bg-brand-tint/40 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-text-muted">Análisis de glosa</div>
        <span
          className={`rounded-md border px-2 py-0.5 text-xs ${qualityColors[glosa.quality]}`}
        >
          {qualityLabel[glosa.quality]}
        </span>
      </div>
      {tags.length === 0 ? (
        <div className="text-xs text-text-muted">
          La glosa no contiene pistas identificables. Recomendar al cajero usar formato:
          <code className="ml-1 text-text">DEP &lt;cliente&gt; &lt;banco&gt; &lt;empresa&gt;</code>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t, idx) => (
            <span
              key={idx}
              className="text-xs rounded-md border border-border-soft bg-bg-card px-2 py-0.5"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Calcula el ratio de tokens del nombre del banco presentes en el nombre Dyn.
 * Espejo simplificado de la función del servidor (match.ts) — útil para
 * indicadores visuales en el modal.
 */
function nameRatioClient(bankName: string | null, dynName: string | null): number | null {
  if (!bankName || !dynName) return null;
  const norm = (s: string): string[] =>
    s
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-ZÑ\s]/g, " ")
      .replace(
        /\b(?:DE|DEL|LA|LOS|LAS|EL|Y|SR|SRA|DON|TRANSFERENCIA|TRANSF|RECIBIDA|DEPOSITO|DEP|PARA|POR)\b/g,
        ""
      )
      .split(/\s+/)
      .filter((w) => w.length >= 3);
  const bankT = new Set(norm(bankName));
  const dynT = new Set(norm(dynName));
  if (bankT.size === 0 || dynT.size === 0) return null;
  let inter = 0;
  for (const t of bankT) if (dynT.has(t)) inter++;
  return inter / bankT.size;
}

function CandidatesList({
  candidates,
  customerRut,
  customerName,
  totalAmount,
  selected,
  onToggle,
  selectedSum,
  sumMatches,
}: {
  candidates: CandidateItem[];
  customerRut: string | null;
  customerName: string | null;
  totalAmount: number;
  selected: Set<string>;
  onToggle: (id: string) => void;
  selectedSum: number;
  sumMatches: boolean;
}) {
  // Separar exactos vs parciales (para pago dividido)
  const exactos = candidates.filter((c) => Number(c.amount) === totalAmount);
  const parciales = candidates.filter((c) => Number(c.amount) !== totalAmount);

  const [showParts, setShowParts] = useState(parciales.length > 0 && exactos.length === 0);

  if (candidates.length === 0) {
    return (
      <div className="mt-5 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
        No hay candidatos disponibles. Probablemente el depósito fue a una
        cuenta no registrada o el banco aún no lo procesó.
      </div>
    );
  }

  function rutMatchesOf(c: CandidateItem): boolean {
    return !!customerRut && c.counterpartyRut === customerRut;
  }

  return (
    <div className="mt-5 space-y-4">
      {/* Sección match exacto */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-brand">
            Match exacto · monto coincide
            <span className="ml-2 text-xs font-normal text-text-muted">
              ({exactos.length})
            </span>
          </div>
          {exactos.length > 0 && (
            <SumCounter
              selectedSum={selectedSum}
              totalDyn={totalAmount}
              match={sumMatches}
            />
          )}
        </div>
        {exactos.length === 0 ? (
          <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-xs text-text-muted">
            Sin abonos con monto exacto en la ventana. Probá revisar pagos divididos abajo.
          </div>
        ) : (
          <div className="space-y-1.5 stagger">
            {exactos.map((c) => (
              <CandidateRow
                key={c.id}
                c={c}
                selected={selected.has(c.id)}
                onToggle={() => onToggle(c.id)}
                rutMatches={rutMatchesOf(c)}
                nameRatio={nameRatioClient(c.counterpartyName, customerName)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sección pago dividido — colapsable */}
      {parciales.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowParts((v) => !v)}
            className="w-full flex items-center justify-between text-left rounded-md border border-border-soft bg-bg-soft hover:bg-bg-elevated transition-colors duration-200 px-3 py-2"
          >
            <div className="text-sm">
              <span className="font-semibold text-brand">Pago dividido</span>
              <span className="ml-2 text-xs text-text-muted">
                ({parciales.length} abono{parciales.length === 1 ? "" : "s"} parcial
                {parciales.length === 1 ? "" : "es"} disponibles para combinar)
              </span>
            </div>
            <svg
              className={
                "h-4 w-4 text-text-muted transition-transform duration-300 " +
                (showParts ? "rotate-180" : "")
              }
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showParts && (
            <div className="space-y-1.5 mt-2 animate-slide-down">
              {exactos.length === 0 && (
                <SumCounter
                  selectedSum={selectedSum}
                  totalDyn={totalAmount}
                  match={sumMatches}
                />
              )}
              {parciales.map((c) => (
                <CandidateRow
                  key={c.id}
                  c={c}
                  selected={selected.has(c.id)}
                  onToggle={() => onToggle(c.id)}
                  rutMatches={rutMatchesOf(c)}
                  nameRatio={nameRatioClient(c.counterpartyName, customerName)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  c,
  selected,
  onToggle,
  rutMatches,
  nameRatio,
}: {
  c: CandidateItem;
  selected: boolean;
  onToggle: () => void;
  rutMatches?: boolean;
  nameRatio?: number | null;
}) {
  const [showScore, setShowScore] = useState(false);
  const score = c.score;
  const scoreColor = !score
    ? null
    : score.hardContradiction || score.total < 40
    ? "danger"
    : score.total >= 80
    ? "success"
    : score.total >= 60
    ? "accent"
    : "warn";

  return (
    <div
      className={
        "rounded-md border transition-all duration-200 ease-out " +
        (selected
          ? "border-accent/60 bg-accent/10 shadow-accent"
          : rutMatches
          ? "border-success/50 bg-success/5"
          : c.isLinked
          ? "border-success/30 bg-success/5"
          : "border-border-soft bg-white hover:border-brand-tonal hover:bg-bg-elevated")
      }
    >
      <button
        onClick={onToggle}
        type="button"
        className="w-full text-left p-2.5"
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            readOnly
            checked={selected}
            className="mt-1 shrink-0"
          />
          <div className="flex-1 min-w-0 text-sm">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-success">
                +{formatMoney(Number(c.amount))}
              </span>
              <span className="text-xs text-text-muted">
                {formatDate(c.postDate)}
              </span>
              <span className="text-xs text-text-muted">·</span>
              <span className="text-xs">
                {c.account.holderName} · {c.account.bankName}
              </span>

              {score && (
                <span
                  className={
                    "text-[11px] rounded-md px-2 py-0.5 font-bold border " +
                    (scoreColor === "success"
                      ? "bg-success/15 text-success border-success/40"
                      : scoreColor === "accent"
                      ? "bg-accent/15 text-accent border-accent/40"
                      : scoreColor === "warn"
                      ? "bg-warn/15 text-warn border-warn/40"
                      : "bg-danger/15 text-danger border-danger/40")
                  }
                  title={`Score ${score.total}/100 · ${score.suggestedStatus}`}
                >
                  Score {score.total}
                </span>
              )}

              {rutMatches && (
                <span className="text-[10px] rounded bg-success/20 text-success px-1.5 py-0.5 font-semibold">
                  ✓ RUT
                </span>
              )}
              {nameRatio !== null && nameRatio !== undefined && (
                <span
                  className={
                    "text-[10px] rounded px-1.5 py-0.5 font-semibold " +
                    (nameRatio >= 0.5
                      ? "bg-success/20 text-success"
                      : nameRatio < 0.2
                      ? "bg-danger/20 text-danger"
                      : "bg-warn/15 text-warn")
                  }
                  title={`Similitud del nombre del banco con cliente Dynatech`}
                >
                  {nameRatio >= 0.5 ? "✓" : nameRatio < 0.2 ? "✕" : "≈"} Nombre {(nameRatio * 100).toFixed(0)}%
                </span>
              )}
              {c.isLinked && !selected && (
                <span className="text-xs text-warn">(se quitará)</span>
              )}
            </div>
            <div className="text-xs text-text-muted truncate" title={c.description}>
              {c.description}
            </div>
            {(c.counterpartyName || c.counterpartyRut) && (
              <div className="text-xs">
                {c.counterpartyName ?? "—"}{" "}
                {c.counterpartyRut && (
                  <span className="text-text-muted">[{c.counterpartyRut}]</span>
                )}
              </div>
            )}
          </div>
        </div>
      </button>

      {score && score.factors.length > 0 && (
        <div className="border-t border-border-soft px-2.5 py-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowScore((v) => !v);
            }}
            className="text-[10px] uppercase tracking-wider text-text-muted font-semibold hover:text-brand transition-colors flex items-center gap-1"
          >
            <svg
              className={
                "h-3 w-3 transition-transform duration-200 " +
                (showScore ? "rotate-90" : "")
              }
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
            {showScore ? "Ocultar" : "Ver"} desglose del score
          </button>
          {showScore && (
            <div className="mt-2 space-y-1 animate-slide-down">
              {score.hardContradiction && (
                <div className="text-xs text-danger font-semibold p-1.5 rounded bg-danger/5 border border-danger/30">
                  ⚠ {score.hardContradiction}
                </div>
              )}
              {score.factors.map((f, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-text-muted">
                    {f.label}
                    {f.detail && (
                      <span className="text-text-dim ml-1">· {f.detail}</span>
                    )}
                  </span>
                  <span
                    className={
                      "font-mono font-semibold " +
                      (f.weight > 0 ? "text-success" : "text-danger")
                    }
                  >
                    {f.weight > 0 ? "+" : ""}
                    {f.weight}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 text-xs pt-1 mt-1 border-t border-border-soft">
                <span className="font-bold text-brand">Total</span>
                <span className="font-mono font-bold text-brand">{score.total}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SumCounter({
  selectedSum,
  totalDyn,
  match,
}: {
  selectedSum: number;
  totalDyn: number;
  match: boolean;
}) {
  const diff = totalDyn - selectedSum;
  return (
    <div className="text-sm">
      <span
        className={
          match
            ? "text-success font-medium"
            : selectedSum === 0
            ? "text-text-muted"
            : "text-warn"
        }
      >
        {formatMoney(selectedSum)} / {formatMoney(totalDyn)}
      </span>
      {!match && selectedSum > 0 && (
        <span className="text-xs text-text-muted ml-2">
          {diff > 0 ? `Falta ${formatMoney(diff)}` : `Sobra ${formatMoney(-diff)}`}
        </span>
      )}
      {match && <span className="ml-1 text-success">✓</span>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    AUTO_MATCHED: { label: "Auto", cls: "border-success/40 text-success bg-success/10" },
    SUGGESTED: { label: "Sugerido", cls: "border-accent/40 text-accent bg-accent/10" },
    REVIEW: { label: "Revisar", cls: "border-warn/40 text-warn bg-warn/10" },
    MANUAL: { label: "Manual", cls: "border-success/40 text-success bg-success/10" },
    NO_MATCH: { label: "Sin match", cls: "border-text-muted/40 text-text-muted bg-bg-card" },
    OUT_OF_SCOPE: { label: "Fuera scope", cls: "border-text-muted/40 text-text-muted bg-bg-card" },
  };
  const m = map[status] ?? { label: status, cls: "border-border-soft" };
  return (
    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs ${m.cls}`}>
      {m.label}
    </span>
  );
}
