"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";
import {
  type DynatechResponse,
  type DynatechMotivo,
  MOTIVO_LABEL,
  MOTIVO_COLOR,
  MOTIVO_ACCION,
  AGING_LABEL,
} from "./types";
import { KpiCard, AgingBar, Breakdown, CategoryChips } from "./ReportPieces";

const MOTIVO_KEYS: DynatechMotivo[] = [
  "sin_procesar",
  "sugerido",
  "revisar",
  "excepcion",
  "sin_match",
  "fuera_scope",
  "acreedor",
];

/**
 * Reporte: movimientos de Dynatech (Tesorería) sin contraparte conciliada en
 * banco. Cada fila trae el MOTIVO (por qué no cuadró) + pista de acción, aging
 * y export a Excel.
 */
export function DynatechSinContraparteView({
  from,
  to,
  onRangeChange,
}: {
  from: string;
  to: string;
  onRangeChange: (from: string, to: string) => void;
}) {
  const [banco, setBanco] = useState("");
  const [tipo, setTipo] = useState<"" | "INGRESO" | "EGRESO">("");
  const [motivo, setMotivo] = useState<DynatechMotivo | "">("");
  const [data, setData] = useState<DynatechResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (banco) p.set("banco", banco);
      if (tipo) p.set("tipo", tipo);
      if (motivo) p.set("motivo", motivo);
      const res = await fetch(`/api/reportes/dynatech-sin-conciliar?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, banco, tipo, motivo]);

  const totalMonto = useMemo(
    () => (data ? BigInt(data.resumen.monto) : 0n),
    [data],
  );
  const hasRows = !!data && data.rows.length > 0;

  function exportXlsx() {
    if (!data || data.rows.length === 0) return;
    const wb = XLSX.utils.book_new();
    const r = data.resumen;

    const resumenAoa: (string | number)[][] = [
      ["Reporte", "Movimientos de Dynatech sin contraparte en banco"],
      ["Rango", `${from} a ${to}`],
      ["Filtros", filtrosLabel(banco, tipo, motivo)],
      [],
      ["Total movimientos", r.count],
      ["Monto total", Number(r.monto)],
      [],
      ["Por tipo", "Cantidad", "Monto"],
      ["Ingresos", r.porTipo.INGRESO?.count ?? 0, Number(r.porTipo.INGRESO?.monto ?? 0)],
      ["Egresos", r.porTipo.EGRESO?.count ?? 0, Number(r.porTipo.EGRESO?.monto ?? 0)],
      [],
      ["Por motivo", "Cantidad", "Monto", "Acción sugerida"],
      ...MOTIVO_KEYS.map((k) => [
        MOTIVO_LABEL[k],
        r.porMotivo[k]?.count ?? 0,
        Number(r.porMotivo[k]?.monto ?? 0),
        MOTIVO_ACCION[k],
      ]),
      [],
      ["Por antigüedad", "Cantidad", "Monto"],
      ...(["0-7", "8-30", "31-60", "60+"] as const).map((b) => [
        AGING_LABEL[b],
        r.porAging[b]?.count ?? 0,
        Number(r.porAging[b]?.monto ?? 0),
      ]),
    ];
    const resumenSheet = XLSX.utils.aoa_to_sheet(resumenAoa);
    resumenSheet["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 36 }];
    XLSX.utils.book_append_sheet(wb, resumenSheet, "Resumen");

    const aoa: (string | number)[][] = [
      [
        "Fecha",
        "Edad (días)",
        "ID Dynatech",
        "Sucursal",
        "Tipo",
        "Monto",
        "Banco",
        "Cliente",
        "RUT",
        "Glosa",
        "Motivo",
        "Acción sugerida",
      ],
    ];
    for (const row of data.rows) {
      aoa.push([
        formatDate(row.fecha),
        row.aging,
        row.externalId,
        row.sucursalName ?? `#${row.sucursalId}`,
        row.tipoOperacion,
        row.tipoOperacion === "EGRESO" ? -Number(row.monto) : Number(row.monto),
        row.banco ?? "",
        row.clienteName ?? "",
        row.clienteRut ?? "",
        row.glosa,
        MOTIVO_LABEL[row.motivo],
        MOTIVO_ACCION[row.motivo],
      ]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [
      { wch: 12 },
      { wch: 11 },
      { wch: 12 },
      { wch: 16 },
      { wch: 10 },
      { wch: 14 },
      { wch: 14 },
      { wch: 20 },
      { wch: 14 },
      { wch: 36 },
      { wch: 18 },
      { wch: 36 },
    ];
    XLSX.utils.book_append_sheet(wb, sheet, "Detalle");

    XLSX.writeFile(wb, `dynatech_sin_contraparte_${from}_${to}.xlsx`);
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <DateInput label="Desde" value={from} onChange={(v) => onRangeChange(v, to)} />
        <DateInput label="Hasta" value={to} onChange={(v) => onRangeChange(from, v)} />
        <select
          value={banco}
          onChange={(e) => setBanco(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todos los bancos</option>
          {data?.facets.bancos.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          value={tipo}
          onChange={(e) => setTipo(e.target.value as "" | "INGRESO" | "EGRESO")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Ingresos y egresos</option>
          <option value="INGRESO">Solo ingresos</option>
          <option value="EGRESO">Solo egresos</option>
        </select>
        <select
          value={motivo}
          onChange={(e) => setMotivo(e.target.value as DynatechMotivo | "")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todos los motivos</option>
          {MOTIVO_KEYS.map((k) => (
            <option key={k} value={k}>
              {MOTIVO_LABEL[k]}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={exportXlsx}
          disabled={!hasRows}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          Descargar Excel
        </button>
      </div>

      {/* Resumen / KPIs */}
      {data && (
        <>
          <div className="flex flex-wrap gap-3">
            <KpiCard
              label="Sin contraparte"
              count={data.resumen.count}
              monto={data.resumen.monto}
              tone="danger"
            />
            <KpiCard
              label="Ingresos"
              count={data.resumen.porTipo.INGRESO?.count ?? 0}
              monto={data.resumen.porTipo.INGRESO?.monto ?? "0"}
            />
            <KpiCard
              label="Egresos"
              count={data.resumen.porTipo.EGRESO?.count ?? 0}
              monto={data.resumen.porTipo.EGRESO?.monto ?? "0"}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <AgingBar porAging={data.resumen.porAging} />
            <CategoryChips
              title="Por motivo"
              items={MOTIVO_KEYS.map((k) => ({
                key: k,
                label: MOTIVO_LABEL[k],
                count: data.resumen.porMotivo[k]?.count ?? 0,
                monto: data.resumen.porMotivo[k]?.monto ?? "0",
                cls: MOTIVO_COLOR[k],
              }))}
            />
          </div>
          <Breakdown title="Por banco asignado" rows={data.resumen.porBanco} />
        </>
      )}

      {data?.truncated && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2 text-xs">
          ⚠ Se muestran las primeras 5.000 filas. Acotá el rango para ver el resto.
        </div>
      )}

      {/* Tabla */}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            🎉 No hay movimientos de Dynatech sin contraparte en este filtro.
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Edad</th>
                  <th className="px-3 py-2 text-left">Sucursal</th>
                  <th className="px-3 py-2 text-center">Tipo</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-left">Banco</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-left">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-border-soft/60 hover:bg-bg-soft/40"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatDate(row.fecha)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <AgingTag days={row.aging} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.sucursalName ?? `#${row.sucursalId}`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={
                          "text-[11px] font-bold " +
                          (row.tipoOperacion === "EGRESO"
                            ? "text-rose-600"
                            : "text-emerald-600")
                        }
                      >
                        {row.tipoOperacion === "EGRESO" ? "EGR" : "ING"}
                      </span>
                    </td>
                    <td
                      className={
                        "px-3 py-2 text-right font-mono whitespace-nowrap " +
                        (row.tipoOperacion === "EGRESO"
                          ? "text-rose-600"
                          : "text-text")
                      }
                    >
                      {row.tipoOperacion === "EGRESO" ? "-" : ""}
                      {formatMoney(BigInt(row.monto))}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.banco ?? <span className="text-text-dim">—</span>}
                    </td>
                    <td
                      className="px-3 py-2 max-w-[280px] truncate"
                      title={row.glosa}
                    >
                      {row.glosa}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${MOTIVO_COLOR[row.motivo]}`}
                        title={MOTIVO_ACCION[row.motivo]}
                      >
                        {MOTIVO_LABEL[row.motivo]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={4}>
                    TOTAL ({data!.resumen.count})
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totalMonto)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function filtrosLabel(banco: string, tipo: string, motivo: string): string {
  const parts: string[] = [];
  if (banco) parts.push(`Banco: ${banco}`);
  if (tipo) parts.push(`Tipo: ${tipo}`);
  if (motivo) parts.push(`Motivo: ${MOTIVO_LABEL[motivo as DynatechMotivo]}`);
  return parts.length ? parts.join(" · ") : "Sin filtros";
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-text-muted">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
      />
    </label>
  );
}

function AgingTag({ days }: { days: number }) {
  const cls =
    days > 60
      ? "text-rose-600 font-bold"
      : days > 30
        ? "text-orange-600 font-semibold"
        : days > 7
          ? "text-amber-600"
          : "text-text-muted";
  return <span className={`text-xs tabular-nums ${cls}`}>{days}d</span>;
}
