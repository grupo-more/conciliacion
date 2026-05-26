"use client";

import type { TesoreriaMovementDTO } from "./types";
import { formatDateTime, formatMoney } from "@/lib/format";

interface Props {
  movement: TesoreriaMovementDTO;
  rubroBancoLabel?: string | null;
  rubroSucursalLabel?: string | null;
  onClose: () => void;
}

export function MovementDetail({
  movement: m,
  rubroBancoLabel,
  rubroSucursalLabel,
  onClose,
}: Props) {
  const monto = Number(m.monto);
  const mismatchBanco =
    m.bancoSucursal !== null &&
    m.bancoDetectado !== null &&
    m.bancoSucursal.trim().toUpperCase() !== m.bancoDetectado.trim().toUpperCase();

  const rubroBancoDisplay =
    m.rubroBanco === null
      ? "—"
      : rubroBancoLabel
      ? `${m.rubroBanco} — ${rubroBancoLabel}`
      : String(m.rubroBanco);
  const rubroSucursalDisplay =
    m.rubroSucursal === null
      ? "—"
      : rubroSucursalLabel
      ? `${m.rubroSucursal} — ${rubroSucursalLabel}`
      : String(m.rubroSucursal);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Movimiento Tesorería</h2>
            <div className="text-xs text-text-muted font-mono">#{m.externalId}</div>
          </div>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {m.esExcepcion && (
          <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            ⚠ Marcado como excepción.
            {mismatchBanco && (
              <>
                {" "}Banco sucursal (<span className="font-semibold">{m.bancoSucursal}</span>) ≠ banco detectado (<span className="font-semibold">{m.bancoDetectado}</span>).
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Fecha" value={formatDateTime(m.fecha)} />
          <Field label="Sucursal" value={`${m.sucursalName ?? "—"} (#${m.sucursalId})`} />
          <Field
            label="Cajero"
            value={m.cajeroName ? `${m.cajeroName} (${m.cajeroUsername})` : m.cajeroUsername}
          />
          <Field
            label="Cliente"
            value={
              m.clienteName || m.clienteRut
                ? `${m.clienteName ?? "—"}${m.clienteRut ? ` · ${m.clienteRut}` : ""}`
                : "—"
            }
          />
          <Field
            label="Documento"
            value={`${m.tipoDocumento ?? "—"} (cod. ${m.codigoDocumento})`}
          />
          <Field label="Folio" value={m.folio === "0" ? "—" : m.folio} mono />
          <Field label="Banco" value={m.banco ?? "—"} />
          <Field label="Banco sucursal" value={m.bancoSucursal ?? "—"} />
          <Field
            label="Banco detectado"
            value={m.bancoDetectado ?? "—"}
            highlight={mismatchBanco}
          />
          <Field label="Rubro Sucursal" value={rubroSucursalDisplay} />
          <Field label="Rubro Banco" value={rubroBancoDisplay} />
          <Field label="Monto" value={formatMoney(monto)} highlight />
          <Field label="Cargado" value={m.fechaCarga ? formatDateTime(m.fechaCarga) : "—"} />
        </div>

        <div className="mt-4">
          <div className="text-xs text-text-muted mb-1">Glosa</div>
          <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm">
            {m.glosa || <span className="text-text-dim">(sin glosa)</span>}
          </div>
        </div>

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
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div
        className={
          (mono ? "font-mono " : "") +
          (highlight ? "font-semibold text-warn" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}
