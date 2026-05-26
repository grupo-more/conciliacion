"use client";

import { useMemo } from "react";
import type { GroupBy, ReportResponse } from "./types";
import { formatMoney } from "@/lib/format";

interface Props {
  report: ReportResponse | null;
  loading: boolean;
  groupBy: GroupBy;
  onGroupByChange: (g: GroupBy) => void;
  onCellClick?: (rowKey: string, colKey: string) => void;
}

const GROUP_LABELS: Record<GroupBy, { row: string; col: string; title: string }> = {
  rubro: {
    row: "Rubro Sucursal",
    col: "Rubro Banco",
    title: "Mapeo rubro Sucursal → rubro Banco",
  },
  banco: {
    row: "Banco Sucursal",
    col: "Banco Detectado",
    title: "Mapeo banco Sucursal → banco Detectado",
  },
  sucursal: {
    row: "Sucursal",
    col: "Banco",
    title: "Mapeo Sucursal → Banco",
  },
};

export function RubroMatrix({ report, loading, groupBy, onGroupByChange, onCellClick }: Props) {
  const labels = GROUP_LABELS[groupBy];

  // Calcular max total para escalar colores del heatmap.
  const maxCellTotal = useMemo(() => {
    if (!report) return 0;
    let max = 0;
    for (const row of report.matrix) {
      for (const c of row.cells) {
        if (c.total > max) max = c.total;
      }
    }
    return max;
  }, [report]);

  function cellStyle(total: number, excepciones: number, count: number): React.CSSProperties {
    if (count === 0) return {};
    const intensity = maxCellTotal > 0 ? Math.min(1, total / maxCellTotal) : 0;
    const exceptionRatio = count > 0 ? excepciones / count : 0;

    // Si predominan excepciones, tono cálido (warn #d97706). Si no, brand #243a85.
    if (exceptionRatio >= 0.5) {
      const op = Math.max(0.15, Math.min(0.8, 0.2 + intensity * 0.55));
      return { backgroundColor: `rgba(217, 119, 6, ${op.toFixed(2)})` };
    }
    const op = Math.max(0.08, Math.min(0.7, 0.1 + intensity * 0.5));
    return { backgroundColor: `rgba(36, 58, 133, ${op.toFixed(2)})` };
  }

  return (
    <div className="card p-0">
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{labels.title}</div>
          <div className="text-xs text-text-muted">
            Cada celda muestra el total y la cantidad de movimientos del cruce.
            {" "}Color cálido = excepciones predominan.
          </div>
        </div>
        <div className="flex gap-1 bg-bg-soft rounded-md p-1 text-xs">
          {(["rubro", "banco", "sucursal"] as GroupBy[]).map((g) => (
            <button
              key={g}
              onClick={() => onGroupByChange(g)}
              className={
                "px-3 py-1 rounded transition-colors " +
                (groupBy === g
                  ? "bg-white shadow-sm text-brand font-semibold"
                  : "text-text-muted hover:text-text")
              }
            >
              {g === "rubro" ? "Rubro" : g === "banco" ? "Banco" : "Sucursal"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="px-4 py-12 text-center text-text-muted text-sm">
          Cargando reporte…
        </div>
      )}

      {!loading && (!report || report.matrix.length === 0) && (
        <div className="px-4 py-12 text-center text-text-muted text-sm">
          Sin datos en el rango seleccionado.
        </div>
      )}

      {!loading && report && report.matrix.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg-soft border-b border-border-soft">
              <tr>
                <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-bg-soft z-10 min-w-[180px]">
                  {labels.row} \ {labels.col}
                </th>
                {report.cols.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                    title={`${col.label} · ${formatMoney(col.total)} · ${col.count} mov`}
                  >
                    <div className="truncate max-w-[140px]">{col.label}</div>
                    <div className="text-[10px] font-normal text-text-muted">
                      {col.count} mov
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold bg-bg-elevated">
                  Total fila
                </th>
              </tr>
            </thead>
            <tbody>
              {report.matrix.map((row) => (
                <tr key={row.rowKey} className="border-t border-border-soft/40">
                  <td className="px-3 py-2 sticky left-0 bg-white z-10 border-r border-border-soft/40">
                    <div className="font-medium truncate max-w-[200px]" title={row.rowLabel}>
                      {row.rowLabel}
                    </div>
                    <div className="text-[10px] text-text-muted">{row.rowCount} mov</div>
                  </td>
                  {row.cells.map((c) => (
                    <td
                      key={c.colKey}
                      style={cellStyle(c.total, c.excepciones, c.count)}
                      className={
                        "px-3 py-2 text-right font-mono whitespace-nowrap transition-colors " +
                        (c.count > 0 && onCellClick
                          ? "cursor-pointer hover:ring-1 hover:ring-brand/40"
                          : "")
                      }
                      onClick={() =>
                        c.count > 0 && onCellClick?.(row.rowKey, c.colKey)
                      }
                    >
                      {c.count === 0 ? (
                        <span className="text-text-dim">·</span>
                      ) : (
                        <>
                          <div>{formatMoney(c.total)}</div>
                          <div className="text-[10px] text-text-muted">
                            {c.count}
                            {c.excepciones > 0 && (
                              <span className="text-warn"> · {c.excepciones} exc</span>
                            )}
                          </div>
                        </>
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono font-semibold bg-bg-elevated whitespace-nowrap">
                    <div>{formatMoney(row.rowTotal)}</div>
                    <div className="text-[10px] text-text-muted font-normal">
                      {row.rowCount}
                      {row.rowExcepciones > 0 && (
                        <span className="text-warn"> · {row.rowExcepciones} exc</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border-soft bg-bg-elevated">
                <td className="px-3 py-2 sticky left-0 bg-bg-elevated z-10 font-semibold">
                  Total columna
                </td>
                {report.cols.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-2 text-right font-mono font-semibold whitespace-nowrap"
                  >
                    <div>{formatMoney(col.total)}</div>
                    <div className="text-[10px] text-text-muted font-normal">
                      {col.count}
                      {col.excepciones > 0 && (
                        <span className="text-warn"> · {col.excepciones} exc</span>
                      )}
                    </div>
                  </td>
                ))}
                <td className="px-3 py-2 text-right font-mono font-bold whitespace-nowrap">
                  <div>{formatMoney(report.grand.total)}</div>
                  <div className="text-[10px] text-text-muted font-normal">
                    {report.grand.count} mov
                    {report.grand.excepciones > 0 && (
                      <span className="text-warn"> · {report.grand.excepciones} exc</span>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

