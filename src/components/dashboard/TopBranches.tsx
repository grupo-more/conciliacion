"use client";

import type { BranchSummary } from "./types";
import { formatMoney } from "@/lib/format";

export function TopBranches({
  branches,
  onDrillSinCliente,
}: {
  branches: BranchSummary[];
  onDrillSinCliente?: (sucursalId?: number) => void;
}) {
  const max = branches[0]?.ventasTotal ?? 0;
  const totalSinCliente = branches.reduce((a, b) => a + b.sinClienteCount, 0);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Top sucursales por volumen</h3>
        {totalSinCliente > 0 && onDrillSinCliente ? (
          <button
            onClick={() => onDrillSinCliente(undefined)}
            className="text-xs font-medium text-danger hover:underline"
            title="Ver todos los movimientos sin cliente del período"
          >
            {totalSinCliente} sin cliente
          </button>
        ) : (
          <span className="text-xs text-text-muted">
            {branches.length} sucursal{branches.length === 1 ? "" : "es"}
          </span>
        )}
      </div>

      {branches.length === 0 ? (
        <div className="text-text-muted text-sm py-4 text-center">
          Sin actividad en el período.
        </div>
      ) : (
        <div className="space-y-2">
          {branches.map((b) => {
            const pct = max > 0 ? (b.ventasTotal / max) * 100 : 0;
            const matchPct = b.matchRate * 100;
            return (
              <div key={b.branchExternalId} className="text-xs">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="truncate">
                    {b.branchExternalName ?? `#${b.branchExternalId}`}
                  </span>
                  <span className="font-mono whitespace-nowrap">
                    {formatMoney(b.ventasTotal)}
                  </span>
                </div>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-elevated">
                  <div
                    className="bg-gradient-to-r from-brand to-accent transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-0.5 text-[10px] text-text-muted">
                  <span>
                    {b.ventasCount} venta{b.ventasCount === 1 ? "" : "s"}
                    {b.sinClienteCount > 0 && (
                      <button
                        onClick={() => onDrillSinCliente?.(b.branchExternalId)}
                        className="ml-2 rounded-full bg-danger/10 text-danger px-1.5 py-0.5 font-semibold hover:bg-danger/20"
                        title={`${b.sinClienteCount} de ${b.movCount} movimientos sin cliente — ver detalle`}
                      >
                        {b.sinClienteCount} sin cliente
                      </button>
                    )}
                  </span>
                  <span>
                    {b.matchedCount}/{b.ventasCount} concil. ({matchPct.toFixed(0)}%)
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
