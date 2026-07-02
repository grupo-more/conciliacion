"use client";

import type { CashierSummary } from "./types";
import { formatMoney } from "@/lib/format";

export function TopCashiers({
  cashiers,
  onDrillSinCliente,
}: {
  cashiers: CashierSummary[];
  onDrillSinCliente?: (cajero?: string) => void;
}) {
  const totalSinCliente = cashiers.reduce((a, c) => a + c.sinClienteCount, 0);
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Cajeros · calidad de glosa</h3>
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
            {cashiers.length} cajero{cashiers.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {cashiers.length === 0 ? (
        <div className="text-text-muted text-sm py-4 text-center">
          Sin actividad en el período.
        </div>
      ) : (
        <div className="space-y-2.5">
          {cashiers.map((c) => {
            const score = c.glosaQualityScore;
            const scoreCls =
              score >= 80
                ? "text-success"
                : score >= 60
                ? "text-accent"
                : score >= 40
                ? "text-warn"
                : "text-danger";
            const total = c.ventasCount;
            const ex = c.glosaQualityCounts.excellent;
            const gd = c.glosaQualityCounts.good;
            const fr = c.glosaQualityCounts.fair;
            const pr = c.glosaQualityCounts.poor;
            return (
              <div key={c.cashierUsername} className="text-xs">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {c.cashierName ? (
                      <>
                        <span>{c.cashierName}</span>
                        <span className="font-mono text-[10px] text-text-muted">
                          {c.cashierUsername}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono">{c.cashierUsername}</span>
                    )}
                    <span className="text-text-muted">
                      · {total} venta{total === 1 ? "" : "s"} ·{" "}
                      {formatMoney(c.ventasTotal)}
                    </span>
                    {c.sinClienteCount > 0 && (
                      <button
                        onClick={() => onDrillSinCliente?.(c.cashierUsername)}
                        className="rounded-full bg-danger/10 text-danger px-1.5 py-0.5 text-[10px] font-semibold hover:bg-danger/20"
                        title={`${c.sinClienteCount} de ${c.movCount} movimientos sin cliente — ver detalle`}
                      >
                        {c.sinClienteCount} sin cliente
                      </button>
                    )}
                  </div>
                  {total > 0 && <span className={`font-medium ${scoreCls}`}>{score}/100</span>}
                </div>
                {total > 0 && (
                  <>
                    <div className="flex h-1.5 rounded-full overflow-hidden bg-bg-elevated">
                      {ex > 0 && <Seg color="bg-success" pct={(ex / total) * 100} />}
                      {gd > 0 && <Seg color="bg-accent" pct={(gd / total) * 100} />}
                      {fr > 0 && <Seg color="bg-warn" pct={(fr / total) * 100} />}
                      {pr > 0 && <Seg color="bg-danger" pct={(pr / total) * 100} />}
                    </div>
                    <div className="flex justify-between mt-0.5 text-[10px] text-text-muted">
                      {ex > 0 && <span className="text-success">{ex} excelente</span>}
                      {gd > 0 && <span className="text-accent">{gd} buena</span>}
                      {fr > 0 && <span className="text-warn">{fr} regular</span>}
                      {pr > 0 && <span className="text-danger">{pr} pobre</span>}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Seg({ color, pct }: { color: string; pct: number }) {
  return <div className={color} style={{ width: `${pct}%` }} />;
}
