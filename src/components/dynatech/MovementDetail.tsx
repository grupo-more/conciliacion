"use client";

import type { DynatechMovementDTO } from "./types";
import { formatDateTime, formatMoney } from "@/lib/format";

interface Props {
  movement: DynatechMovementDTO;
  /** Nombre legible del rubro (si existe en RubroLabel). null si no hay etiqueta. */
  rubroLabel?: string | null;
  onClose: () => void;
}

export function MovementDetail({ movement, rubroLabel, onClose }: Props) {
  const m = movement;
  const totalAmount = Number(m.totalAmount);

  const rubroDisplay =
    m.rubro === null
      ? "Sin rubro"
      : rubroLabel
      ? `${m.rubro} — ${rubroLabel}`
      : String(m.rubro);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Movimiento Dynatech</h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="mCjId" value={m.mCjId} mono />
          <Field label="Sucursal" value={`${m.branchExternalName ?? "—"} (#${m.branchExternalId})`} />
          <Field
            label="Cajero"
            value={m.cashierName ? `${m.cashierName} (${m.cashierUsername})` : m.cashierUsername}
          />
          <Field
            label="Cliente"
            value={
              m.customerRut
                ? `${m.customerName ?? "—"}${m.customerRut ? ` · ${m.customerRut}` : ""}`
                : "Cliente genérico"
            }
          />
          <Field label="Fecha" value={formatDateTime(m.occurredAt)} />
          <Field
            label="Documento"
            value={`${m.documentType ?? "—"} (cod. ${m.documentCode})`}
          />
          <Field
            label="Folio"
            value={m.documentFolio === "0" ? "—" : m.documentFolio}
            mono
          />
          <Field
            label="Total"
            value={formatMoney(totalAmount, m.currency)}
            highlight
          />
          <Field
            label="Cargado"
            value={m.loadedAt ? formatDateTime(m.loadedAt) : "—"}
          />
          <Field
            label="Rubro"
            value={rubroDisplay}
            mono={m.rubro !== null && !rubroLabel}
            muted={m.rubro === null}
          />
        </div>

        <div className="mt-4">
          <div className="text-xs text-text-muted mb-1">Observación (mCjObs)</div>
          <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm">
            {m.observation || <span className="text-text-dim">(sin observación)</span>}
          </div>
        </div>

        {m.items.length > 0 && (
          <div className="mt-4">
            <div className="text-xs text-text-muted mb-1">Items</div>
            <div className="rounded-md border border-border-soft overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-bg-soft text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Operación</th>
                    <th className="px-3 py-2 text-right">Cantidad</th>
                    <th className="px-3 py-2 text-right">Precio unit.</th>
                    <th className="px-3 py-2 text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {m.items.map((it, idx) => (
                    <tr key={idx} className="border-t border-border-soft">
                      <td className="px-3 py-2">{it.nombre}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {it.cantidad.toLocaleString("es-CL", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {it.precioUnitario.toLocaleString("es-CL", {
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatMoney(Math.round(it.monto))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-text-dim">
          Sincronizado: {formatDateTime(m.syncedAt)}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  highlight,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div
        className={
          (mono ? "font-mono " : "") +
          (highlight ? "font-semibold text-success " : "") +
          (muted ? "text-text-dim italic" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
