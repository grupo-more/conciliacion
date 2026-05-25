"use client";

import { useMemo, useState } from "react";
import type { BankAccountDTO } from "./types";

interface Props {
  movementIds: string[];
  sourceBankCode: string;
  accounts: BankAccountDTO[];
  onClose: () => void;
  onDone: () => void;
}

export function ReassignModal({
  movementIds,
  sourceBankCode,
  accounts,
  onClose,
  onDone,
}: Props) {
  // Cuentas destino válidas: mismo banco, no Sin asignar
  const targets = useMemo(
    () =>
      accounts.filter(
        (a) => a.bankCode === sourceBankCode && !a.isUnassigned
      ),
    [accounts, sourceBankCode]
  );

  const [targetId, setTargetId] = useState<string>(targets[0]?.id ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    moved: number;
    deletedAsDuplicate: number;
  } | null>(null);

  async function submit() {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cartolas/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ movementIds, targetAccountId: targetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Error al reasignar");
        return;
      }
      setResult({
        moved: data.moved,
        deletedAsDuplicate: data.deletedAsDuplicate,
      });
      onDone();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight">Reasignar movimientos</h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm">
              ✓ {result.moved} movimientos movidos.
              {result.deletedAsDuplicate > 0 && (
                <>
                  {" "}
                  {result.deletedAsDuplicate} eliminados por estar ya en la cuenta
                  destino.
                </>
              )}
            </div>
            <div className="flex justify-end">
              <button onClick={onClose} className="btn-primary">
                Cerrar
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm">
              Seleccionados: <strong>{movementIds.length}</strong> movimientos.
              <div className="text-xs text-text-muted mt-1">
                Si alguno ya existe en la cuenta destino, se eliminará automáticamente
                el huérfano para evitar duplicados.
              </div>
            </div>

            <div>
              <label className="label">Cuenta destino ({sourceBankCode})</label>
              {targets.length === 0 ? (
                <div className="text-sm text-danger">
                  No hay cuentas registradas para este banco. Crea una primero.
                </div>
              ) : (
                <select
                  className="input"
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                >
                  {targets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.holderName} — {a.displayNumber || a.accountNumber}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {error && <div className="text-sm text-danger">{error}</div>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn-ghost">
                Cancelar
              </button>
              <button
                onClick={submit}
                className="btn-primary"
                disabled={loading || !targetId || targets.length === 0}
              >
                {loading ? "Reasignando…" : "Reasignar"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
