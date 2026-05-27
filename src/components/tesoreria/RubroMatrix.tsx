"use client";

import { useMemo, useState } from "react";
import type { GroupBy, ReportResponse } from "./types";
import { formatMoney } from "@/lib/format";

interface Props {
  report: ReportResponse | null;
  loading: boolean;
  groupBy: GroupBy;
  onGroupByChange: (g: GroupBy) => void;
  onCellClick?: (rowKey: string, colKey: string) => void;
}

const GROUP_LABELS: Record<GroupBy, { row: string; col: string; title: string; helper: string }> = {
  rubro: {
    row: "Rubro Sucursal",
    col: "Rubro Banco",
    title: "Mapeo rubro Sucursal → rubro Banco",
    helper:
      "Cada celda muestra el cruce de rubros. Casos con excepciones suelen merecer revisión.",
  },
  banco: {
    row: "Banco Sucursal",
    col: "Banco Detectado",
    title: "Mapeo banco Sucursal → banco Detectado",
    helper:
      "Los movimientos 'Normal · sin detección' son los que la API consideró OK. Las otras columnas son posibles excepciones.",
  },
  sucursal: {
    row: "Sucursal",
    col: "Banco",
    title: "Mapeo Sucursal → Banco",
    helper:
      "Qué bancos usa cada sucursal. Excepciones marcan operaciones fuera del banco habitual.",
  },
};

export function RubroMatrix({
  report,
  loading,
  groupBy,
  onGroupByChange,
  onCellClick,
}: Props) {
  const labels = GROUP_LABELS[groupBy];

  // Default ON: el usuario quiere ir directo a lo accionable.
  const [onlyExceptions, setOnlyExceptions] = useState(true);

  // Calcular max total para escalar colores del heatmap (sobre matriz completa).
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

  // Aplicar filtro "solo excepciones": ocultar filas y columnas sin ninguna
  // celda con excepciones. La fila/columna queda fuera si TODAS sus celdas
  // tienen 0 excepciones.
  const { visibleMatrix, visibleCols, totalExceptions } = useMemo(() => {
    if (!report) {
      return {
        visibleMatrix: [] as ReportResponse["matrix"],
        visibleCols: [] as ReportResponse["cols"],
        totalExceptions: 0,
      };
    }
    const total = report.grand.excepciones;

    if (!onlyExceptions) {
      return {
        visibleMatrix: report.matrix,
        visibleCols: report.cols,
        totalExceptions: total,
      };
    }

    // Columnas que tienen al menos una celda con excepciones en alguna fila
    const colKeysWithExc = new Set<string>();
    for (const row of report.matrix) {
      for (const c of row.cells) {
        if (c.excepciones > 0) colKeysWithExc.add(c.colKey);
      }
    }
    const filteredCols = report.cols.filter((c) => colKeysWithExc.has(c.key));

    // Filas que tienen al menos una celda con excepciones
    const filteredMatrix = report.matrix
      .filter((row) => row.rowExcepciones > 0)
      .map((row) => ({
        ...row,
        cells: row.cells.filter((c) => colKeysWithExc.has(c.colKey)),
      }));

    return {
      visibleMatrix: filteredMatrix,
      visibleCols: filteredCols,
      totalExceptions: total,
    };
  }, [report, onlyExceptions]);

  function cellStyle(
    total: number,
    excepciones: number,
    count: number
  ): React.CSSProperties {
    if (count === 0) return {};
    const intensity = maxCellTotal > 0 ? Math.min(1, total / maxCellTotal) : 0;
    const exceptionRatio = count > 0 ? excepciones / count : 0;

    if (exceptionRatio >= 0.5) {
      const op = Math.max(0.15, Math.min(0.8, 0.2 + intensity * 0.55));
      return { backgroundColor: `rgba(217, 119, 6, ${op.toFixed(2)})` };
    }
    const op = Math.max(0.08, Math.min(0.7, 0.1 + intensity * 0.5));
    return { backgroundColor: `rgba(36, 58, 133, ${op.toFixed(2)})` };
  }

  const hasReport = !!report && report.matrix.length > 0;
  const totalMovs = report?.grand.count ?? 0;
  const totalNormal = totalMovs - totalExceptions;
  const pctExc = totalMovs > 0 ? (totalExceptions / totalMovs) * 100 : 0;
  const hasFiltered = onlyExceptions && hasReport && totalExceptions > 0;
  const filteredEmpty =
    onlyExceptions && hasReport && totalExceptions === 0;

  return (
    <div className="card p-0">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-border-soft px-4 py-3 gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{labels.title}</div>
          <div className="text-xs text-text-muted">{labels.helper}</div>
        </div>
        <div className="flex gap-1 bg-bg-soft rounded-md p-1 text-xs shrink-0">
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

      {/* Banner KPI + toggle "solo excepciones" */}
      {hasReport && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-bg-soft/40 border-b border-border-soft gap-3 flex-wrap">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-text-muted">Resumen:</span>
            <span>
              <strong className="text-brand">{totalMovs}</strong> movimientos
            </span>
            <span className="text-text-dim">·</span>
            <span>
              <strong className="text-success">{totalNormal}</strong> normales
            </span>
            <span className="text-text-dim">·</span>
            <span>
              <strong className={totalExceptions > 0 ? "text-warn" : "text-text-muted"}>
                {totalExceptions} excepciones
              </strong>
              {totalExceptions > 0 && (
                <span className="text-text-muted ml-1">({pctExc.toFixed(1)}%)</span>
              )}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs whitespace-nowrap cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyExceptions}
              onChange={(e) => setOnlyExceptions(e.target.checked)}
              className="accent-brand"
            />
            <span className="font-semibold">Solo excepciones</span>
            <span className="text-text-muted">(oculta los movimientos normales)</span>
          </label>
        </div>
      )}

      {/* Estados */}
      {loading && (
        <div className="px-4 py-12 text-center text-text-muted text-sm">
          Cargando reporte…
        </div>
      )}

      {!loading && !hasReport && (
        <div className="px-4 py-12 text-center text-text-muted text-sm">
          Sin datos en el rango seleccionado.
        </div>
      )}

      {!loading && filteredEmpty && (
        <div className="px-4 py-12 text-center">
          <div className="text-3xl mb-2">✓</div>
          <div className="text-sm font-semibold text-success">
            Sin excepciones en este período
          </div>
          <div className="text-xs text-text-muted mt-1">
            Todos los movimientos son normales. Si querés ver el panorama completo,
            desmarcá "Solo excepciones" arriba.
          </div>
        </div>
      )}

      {!loading && hasFiltered && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-bg-soft border-b border-border-soft">
              <tr>
                <th className="px-3 py-2 text-left font-semibold sticky left-0 bg-bg-soft z-10 min-w-[180px]">
                  {labels.row} \ {labels.col}
                </th>
                {visibleCols.map((col) => (
                  <th
                    key={col.key}
                    className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                    title={`${col.label} · ${formatMoney(col.total)} · ${col.count} mov · ${col.excepciones} exc`}
                  >
                    <div className="truncate max-w-[140px]">{col.label}</div>
                    <div className="text-[10px] font-normal text-text-muted">
                      {col.count} mov
                      {col.excepciones > 0 && (
                        <span className="text-warn"> · {col.excepciones} exc</span>
                      )}
                    </div>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold bg-bg-elevated">
                  Total fila
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleMatrix.map((row) => (
                <tr key={row.rowKey} className="border-t border-border-soft/40">
                  <td className="px-3 py-2 sticky left-0 bg-white z-10 border-r border-border-soft/40">
                    <div className="font-medium truncate max-w-[200px]" title={row.rowLabel}>
                      {row.rowLabel}
                    </div>
                    <div className="text-[10px] text-text-muted">
                      {row.rowCount} mov
                      {row.rowExcepciones > 0 && (
                        <span className="text-warn"> · {row.rowExcepciones} exc</span>
                      )}
                    </div>
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
              {/* Total columna: solo cuando NO esta filtrando, para no confundir */}
              {!onlyExceptions && report && (
                <tr className="border-t-2 border-border-soft bg-bg-elevated">
                  <td className="px-3 py-2 sticky left-0 bg-bg-elevated z-10 font-semibold">
                    Total columna
                  </td>
                  {visibleCols.map((col) => (
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
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
