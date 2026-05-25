"use client";

import type { BranchSummary } from "./types";
import { formatMoney } from "@/lib/format";

export function TopBranches({ branches }: { branches: BranchSummary[] }) {
  const max = branches[0]?.ventasTotal ?? 0;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Top sucursales por volumen</h3>
        <span className="text-xs text-text-muted">
          {branches.length} sucursal{branches.length === 1 ? "" : "es"}
        </span>
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
