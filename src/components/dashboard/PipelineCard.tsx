"use client";

import type { PipelineData } from "./types";

interface Props {
  pipeline: PipelineData;
}

export function PipelineCard({ pipeline }: Props) {
  const stages: Array<{
    key: keyof PipelineData["byStatus"];
    label: string;
    cls: string;
  }> = [
    { key: "AUTO_MATCHED", label: "Auto", cls: "bg-success" },
    { key: "MANUAL", label: "Manual", cls: "bg-success/70" },
    { key: "SUGGESTED", label: "Sugeridos", cls: "bg-accent" },
    { key: "REVIEW", label: "Revisar", cls: "bg-warn" },
    { key: "NO_MATCH", label: "Sin match", cls: "bg-text-muted" },
    { key: "OUT_OF_SCOPE", label: "Fuera scope", cls: "bg-text-dim" },
    { key: "UNPROCESSED", label: "Sin procesar", cls: "bg-bg-elevated border border-border-soft" },
  ];

  const total = pipeline.total;

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Pipeline de conciliación</h3>
        <span className="text-xs text-text-muted">
          {total} venta{total === 1 ? "" : "s"} Tesorería
        </span>
      </div>

      {total === 0 ? (
        <div className="text-text-muted text-sm py-4 text-center">
          Sin ventas Tesorería en este período.
        </div>
      ) : (
        <>
          {/* Barra apilada */}
          <div className="flex h-3 rounded-full overflow-hidden bg-bg-elevated ring-1 ring-border/30">
            {stages.map((s) => {
              const count = pipeline.byStatus[s.key];
              if (count === 0) return null;
              const pct = (count / total) * 100;
              return (
                <div
                  key={s.key}
                  className={s.cls}
                  style={{ width: `${pct}%` }}
                  title={`${s.label}: ${count} (${pct.toFixed(1)}%)`}
                />
              );
            })}
          </div>

          {/* Lista detallada */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 mt-3">
            {stages.map((s) => {
              const count = pipeline.byStatus[s.key];
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div
                  key={s.key}
                  className="flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${s.cls}`} />
                    <span className="truncate">{s.label}</span>
                  </div>
                  <div className="text-text-muted whitespace-nowrap">
                    <span className="font-mono">{count}</span>{" "}
                    <span className="text-text-dim">({pct.toFixed(0)}%)</span>
                  </div>
                </div>
              );
            })}
          </div>

          {pipeline.backlogOver7d > 0 && (
            <div className="mt-3 pt-3 border-t border-border-soft text-xs text-warn">
              ⚠ {pipeline.backlogOver7d} movimiento
              {pipeline.backlogOver7d === 1 ? "" : "s"} en este período llevan
              {pipeline.backlogOver7d === 1 ? "" : "n"} {">"}7 días sin acción
            </div>
          )}
        </>
      )}
    </div>
  );
}
