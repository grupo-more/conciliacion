"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, pickDescripcion, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";
import {
  EmisionesPanel,
  EmisionesToggle,
  emitirDocumento,
  type OrigenDerivado,
} from "./EmisionesDerivadas";

interface DifMenorRow {
  groupId: string;
  side: "BANCO" | "DIFERENCIA";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  cuenta: string;
  cliente: string;
  glosa: string;
  debe: string | null;
  haber: string | null;
  bankMovementId: string;
  totalMonto: string;
}

interface DifMenorResponse {
  from: string;
  to: string;
  settings: { threshold: number; rubroDiferencia: number; rubroComision: number };
  rows: DifMenorRow[];
  totals: { debe: string; haber: string };
  facets: { accounts: { id: string; label: string }[] };
}

type Modo = "ingresos" | "egresos" | "comisiones";

/**
 * Tab "Diferencias y comisiones" de Consolidados (ex "Dif menor a 100").
 * Muestra movimientos solo-banco como asiento contable Debe/Haber automático,
 * en 3 modos con emisión independiente (el conteo y los Emitidos no se mezclan):
 *  - Ingresos (IN ≤ umbral):  banco DEBE / diferencia HABER. Origen DIF_MENOR.
 *  - Egresos  (OUT ≤ umbral): banco HABER / diferencia DEBE. Origen DIF_MENOR_EGRESO.
 *  - Comisiones (OUT sin contraparte, glosa comisión/cargo, cualquier monto):
 *    banco HABER / rubro comisión DEBE. Origen COMISION.
 *
 * Umbral y ambos rubros destino son editables desde Configuración.
 */
export function DifMenorView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [modo, setModo] = useState<Modo>("ingresos");

  const esEgreso = modo === "egresos";
  const esComision = modo === "comisiones";
  const origen: OrigenDerivado = esComision
    ? "COMISION"
    : esEgreso
      ? "DIF_MENOR_EGRESO"
      : "DIF_MENOR";

  const [data, setData] = useState<DifMenorResponse | null>(null);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      p.set("direction", modo === "ingresos" ? "IN" : "OUT");
      if (esComision) p.set("modo", "comision");
      if (accountId) p.set("accountId", accountId);
      const res = await fetch(`/api/consolidados/dif-menor?${p}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, accountId, modo]);

  const totals = useMemo(() => {
    if (!data) return { debe: 0n, haber: 0n };
    return {
      debe: BigInt(data.totals.debe),
      haber: BigInt(data.totals.haber),
    };
  }, [data]);

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (!data || data.rows.length === 0) return null;
    const descripcion = esComision
      ? `Comisiones bancarias ${formatDate(from)} al ${formatDate(to)}`
      : `Diferencias menores ${esEgreso ? "egresos " : ""}${formatDate(from)} al ${formatDate(to)}`;
    return {
      options: {
        fecha: to,
        descripcion,
        lineas: data.rows.map((r) => ({
          rubro: r.rubro ?? "",
          detalle: pickDescripcion(r.cliente, r.glosa, r.detalle),
          debe: r.debe,
          haber: r.haber,
        })),
      },
      filename: esComision
        ? `comisiones_${from}_${to}`
        : `dif_menor_${esEgreso ? "egreso_" : ""}${from}_${to}`,
    };
  }

  function exportXlsx() {
    const a = buildAsiento();
    if (a) exportAsi1Xls(a.options, a.filename);
  }

  const [verEmitidos, setVerEmitidos] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [emitirErr, setEmitirErr] = useState<string | null>(null);

  async function emitir() {
    const a = buildAsiento();
    if (!a || !data) return;
    const refIds = Array.from(new Set(data.rows.map((r) => r.bankMovementId)));
    const que = esComision ? "comisión(es) bancaria(s)" : "diferencia(s) menor(es)";
    if (
      !confirm(
        `Se emitirán ${refIds.length} ${que} como un documento con folio nuevo. ` +
          `Saldrán de esta vista y quedarán en "Emitidos" (re-descargables, deshacer disponible). ¿Continuar?`,
      )
    )
      return;
    setEmitiendo(true);
    setEmitirErr(null);
    try {
      const r = await emitirDocumento({ origen, from, to, asiento: a, refIds });
      if (!r.ok) setEmitirErr(r.error);
      else load();
    } finally {
      setEmitiendo(false);
    }
  }

  const hasRows = data && data.rows.length > 0;
  const movimientosCount = data ? data.rows.length / 2 : 0;
  const threshold = data?.settings.threshold ?? 100;

  const modoBtn = (m: Modo, label: string, title?: string) => (
    <button
      onClick={() => {
        setModo(m);
        setAccountId("");
      }}
      className={`px-3 py-1.5 font-semibold ${modo === m ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
      title={title}
    >
      {label}
    </button>
  );

  const dirToggle = (
    <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-sm">
      {modoBtn("ingresos", "Ingresos")}
      {modoBtn("egresos", "Egresos")}
      {modoBtn(
        "comisiones",
        "Comisiones",
        "Comisiones y cargos del propio banco (sin contraparte): asiento automático Debe rubro comisión / Haber banco",
      )}
    </div>
  );

  if (verEmitidos) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <EmisionesToggle emitidos onChange={setVerEmitidos} />
          {dirToggle}
        </div>
        <EmisionesPanel origen={origen} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <EmisionesToggle emitidos={false} onChange={setVerEmitidos} />
        {dirToggle}
      </div>
      {emitirErr && (
        <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">
          {emitirErr}
          <button onClick={() => setEmitirErr(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}
      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Desde</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las cuentas</option>
          {data?.facets.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-text-muted">
          {esComision ? (
            <>
              Rubro comisión: <strong>{data?.settings.rubroComision ?? 1503}</strong>
            </>
          ) : (
            <>
              Umbral actual: <strong>{formatMoney(threshold)}</strong>
            </>
          )}
          {hasRows && (
            <>
              {" · "}
              {movimientosCount} movimiento{movimientosCount === 1 ? "" : "s"}
            </>
          )}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setPreview(buildAsiento())}
          disabled={!hasRows}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm font-semibold hover:bg-bg-soft disabled:opacity-50"
        >
          Vista previa
        </button>
        <button
          onClick={exportXlsx}
          disabled={!hasRows}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm font-semibold hover:bg-bg-soft disabled:opacity-50"
        >
          Descargar Excel
        </button>
        <button
          onClick={emitir}
          disabled={!hasRows || emitiendo}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          title="Descarga el documento y mueve estas diferencias a Emitidos (documento ingresado al otro sistema)"
        >
          {emitiendo ? "Emitiendo…" : `Emitir documento${hasRows ? ` (${movimientosCount})` : ""}`}
        </button>
      </div>

      {/* Tabla */}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">
            Cargando…
          </div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            {esComision
              ? "No hay comisiones bancarias por emitir en este rango."
              : `No hay diferencias menores ${esEgreso ? "de egreso" : "de ingreso"} en este rango.`}
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Rubro</th>
                  <th className="px-3 py-2 text-left">Detalle</th>
                  <th className="px-3 py-2 text-left">Cliente</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const prev = idx > 0 ? data!.rows[idx - 1] : null;
                  const isGroupStart = !prev || prev.groupId !== r.groupId;
                  return (
                    <AsientoRow
                      key={`${r.groupId}-${r.side}`}
                      row={r}
                      isGroupStart={isGroupStart}
                    />
                  );
                })}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={5}>
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.debe)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.haber)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {preview && (
        <Asi1PreviewModal
          options={preview.options}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function AsientoRow({
  row,
  isGroupStart,
}: {
  row: DifMenorRow;
  isGroupStart: boolean;
}) {
  const bg = isGroupStart ? "bg-white" : "bg-bg-soft/40";
  const sinRubro = row.side === "BANCO" && row.rubro === null;
  return (
    <tr
      className={
        "text-sm " +
        (isGroupStart ? "border-t-2 border-border-soft/80 " : "") +
        bg
      }
    >
      <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
        {isGroupStart ? formatDate(row.fecha) : ""}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap font-mono">
        {row.rubro ?? "—"}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        {row.detalle}
        {sinRubro && (
          <span
            className="ml-1.5 inline-block rounded-full bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 font-bold"
            title="No se pudo inferir el rubro de esta cuenta — definir un RubroLabel con nombre que coincida"
          >
            SIN RUBRO
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 max-w-[260px] truncate" title={row.cliente}>
        {isGroupStart ? row.cliente : ""}
      </td>
      <td className="px-3 py-1.5 max-w-[320px] truncate" title={row.glosa}>
        {row.glosa}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.debe ? formatMoney(BigInt(row.debe)) : ""}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.haber ? formatMoney(BigInt(row.haber)) : ""}
      </td>
    </tr>
  );
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function firstDayOfMonthIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}
