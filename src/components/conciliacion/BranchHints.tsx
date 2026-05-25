"use client";

import { useEffect, useState } from "react";
import type { BranchDTO, AccountSlim } from "./types";

interface AccountOpt extends AccountSlim {
  id: string;
  isUnassigned: boolean;
}

export function BranchHints({ onClose }: { onClose: () => void }) {
  const [branches, setBranches] = useState<BranchDTO[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [bRes, aRes] = await Promise.all([
      fetch("/api/branches"),
      fetch("/api/bank-accounts"),
    ]);
    const bJson = await bRes.json();
    const aJson = await aRes.json();
    setBranches(bJson.branches);
    setAccounts(aJson.accounts);
    setLoading(false);
  }

  async function setHint(branchId: number, accountId: string) {
    await fetch(`/api/branches/${branchId}/hint`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    await load();
  }

  async function clearHint(branchId: number) {
    await fetch(`/api/branches/${branchId}/hint`, { method: "DELETE" });
    await load();
  }

  useEffect(() => {
    load();
  }, []);

  const realAccounts = accounts.filter((a) => !a.isUnassigned);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Sucursales y cuentas</h2>
          <button onClick={onClose} className="btn-ghost text-sm" aria-label="Cerrar">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-text-muted mb-4">
          Asigna opcionalmente una cuenta por defecto a cada sucursal. Si la
          observación del depósito menciona explícitamente otro banco, esa información
          gana sobre el default. Sin default, el sistema infiere por historial cuando
          alcanza ≥70% de uso de una cuenta específica.
        </p>

        {loading && <div className="py-8 text-center text-text-muted">Cargando…</div>}

        {!loading && (
          <div className="space-y-2">
            {branches.map((b) => {
              const totalConfirmed = b.history.totalConfirmed;
              const top = b.history.distribution[0];
              return (
                <div
                  key={b.externalId}
                  className="rounded-md border border-border-soft bg-bg-soft p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {b.name ?? `#${b.externalId}`}
                      </div>
                      <div className="text-xs text-text-muted">
                        Sucursal #{b.externalId} · {b.movementCount} movimientos en Dynatech
                      </div>
                      {totalConfirmed > 0 && top && (
                        <div className="text-xs text-text-muted mt-1">
                          Historial: {top.holderName} ({Math.round(top.ratio * 100)}%
                          de {totalConfirmed} confirmados)
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        value={b.hint?.accountId ?? ""}
                        onChange={(e) => {
                          if (e.target.value) {
                            setHint(b.externalId, e.target.value);
                          } else {
                            clearHint(b.externalId);
                          }
                        }}
                        className="input text-xs min-w-[220px]"
                      >
                        <option value="">— Sin default —</option>
                        {realAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.holderName} · {a.bankName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
            {branches.length === 0 && (
              <div className="text-center text-text-muted py-6">
                No hay sucursales registradas todavía. Sincroniza Dynatech primero.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
