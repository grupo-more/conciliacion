"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, pickDescripcion, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";
import { EmisionesPanel, EmisionesToggle, emitirDocumento } from "./EmisionesDerivadas";
import type { OKResponse, OKRow } from "./types";

/**
 * Tab "OK" de Consolidados: muestra los conciliados (AUTO_MATCHED + MANUAL)
 * como asiento contable de partida doble, con exportación a Excel.
 */
export function OKView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [rubroSucursal, setRubroSucursal] = useState<string>("");

  const [data, setData] = useState<OKResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [undoTarget, setUndoTarget] = useState<OKRow | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);

  async function confirmUndo() {
    if (!undoTarget) return;
    setUndoing(true);
    try {
      const res = await fetch(
        `/api/consolidados/${undoTarget.tesoreriaId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reject" }),
        }
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || "Error al deshacer");
        return;
      }
      setUndoTarget(null);
      await load();
    } finally {
      setUndoing(false);
    }
  }

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (accountId) p.set("accountId", accountId);
      if (rubroSucursal) p.set("rubroSucursal", rubroSucursal);
      const res = await fetch(`/api/consolidados/ok?${p}`);
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
  }, [from, to, accountId, rubroSucursal]);

  const totals = useMemo(() => {
    if (!data) return { debe: 0n, haber: 0n };
    return {
      debe: BigInt(data.totals.debe),
      haber: BigInt(data.totals.haber),
    };
  }, [data]);

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (!data || data.rows.length === 0) return null;
    return {
      options: {
        fecha: to,
        descripcion: `Conciliados ${formatDate(from)} al ${formatDate(to)}`,
        lineas: data.rows.map((r) => ({
          rubro: r.rubro ?? "",
          detalle: pickDescripcion(r.cliente, r.glosa, r.detalle),
          debe: r.debe,
          haber: r.haber,
        })),
      },
      filename: `asiento_${from}_${to}`,
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
    // Referencia estable: tesoreriaId (el consolidadoId cambia en cada corrida
    // del motor, que hace wipe+recreate de los no-MANUAL).
    const refIds = Array.from(new Set(data.rows.map((r) => r.tesoreriaId)));
    if (
      !confirm(
        `Se emitirán ${refIds.length} conciliado(s) como un documento con folio nuevo. ` +
          `Saldrán de esta vista y quedarán en "Emitidos" (re-descargables, deshacer disponible). ¿Continuar?`,
      )
    )
      return;
    setEmitiendo(true);
    setEmitirErr(null);
    try {
      const r = await emitirDocumento({ origen: "OK", from, to, asiento: a, refIds });
      if (!r.ok) setEmitirErr(r.error);
      else load();
    } finally {
      setEmitiendo(false);
    }
  }

  const hasRows = data && data.rows.length > 0;

  if (verEmitidos) {
    return (
      <div className="space-y-4">
        <EmisionesToggle emitidos onChange={setVerEmitidos} />
        <EmisionesPanel origen="OK" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <EmisionesToggle emitidos={false} onChange={setVerEmitidos} />
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
        <select
          value={rubroSucursal}
          onChange={(e) => setRubroSucursal(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las sucursales</option>
          {data?.facets.rubrosSucursales.map((r) => (
            <option key={r.rubro} value={String(r.rubro)}>
              {r.rubro} {r.label ? `— ${r.label}` : ""}
            </option>
          ))}
        </select>
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
          title="Descarga el documento y mueve estos conciliados a Emitidos (documento ingresado al otro sistema)"
        >
          {emitiendo ? "Emitiendo…" : "Emitir documento"}
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
            No hay conciliados en este rango.
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
                  <th className="px-3 py-2 text-center w-20"></th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const prev = idx > 0 ? data!.rows[idx - 1] : null;
                  const isGroupStart = !prev || prev.groupId !== r.groupId;
                  return (
                    <AsientoRow
                      key={`${r.groupId}-${r.side}-${idx}`}
                      row={r}
                      isGroupStart={isGroupStart}
                      onUndo={isGroupStart ? () => setUndoTarget(r) : undefined}
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
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {undoTarget && (
        <OKUndoConfirmModal
          row={undoTarget}
          loading={undoing}
          onCancel={() => setUndoTarget(null)}
          onConfirm={confirmUndo}
        />
      )}

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
  onUndo,
}: {
  row: OKRow;
  isGroupStart: boolean;
  onUndo?: () => void;
}) {
  const isAjuste = row.side === "AJUSTE";
  const bg = isGroupStart
    ? "bg-white"
    : isAjuste
    ? "bg-amber-50/60"
    : "bg-bg-soft/40";
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
        {isAjuste && (
          <span className="ml-1.5 inline-block rounded-full bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 font-bold">
            AJUSTE
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
      <td className="px-3 py-1.5 text-center">
        {onUndo && (
          <button
            onClick={onUndo}
            className="text-[11px] text-rose-700 hover:underline whitespace-nowrap"
            title="Deshacer match (pide confirmación)"
          >
            Deshacer
          </button>
        )}
      </td>
    </tr>
  );
}

function OKUndoConfirmModal({
  row,
  loading,
  onCancel,
  onConfirm,
}: {
  row: OKRow;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isAuto = row.status === "AUTO_MATCHED";
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-panel max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight mb-2">
          Deshacer este match?
        </h2>
        <p className="text-sm text-text-muted mb-4">
          La conciliación volverá a estado <strong>NO_MATCH</strong> y el
          asiento desaparecerá de OK. Confirmá los datos antes:
        </p>

        <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm space-y-1 mb-3">
          <div>
            <span className="text-text-muted">Fecha:</span>{" "}
            <strong>{formatDate(row.fecha)}</strong>
          </div>
          <div>
            <span className="text-text-muted">Cliente:</span> {row.cliente}
          </div>
          <div>
            <span className="text-text-muted">Monto:</span>{" "}
            <strong className="font-mono">
              {formatMoney(BigInt(row.totalMonto))}
            </strong>
          </div>
          <div>
            <span className="text-text-muted">Glosa:</span> {row.glosa || "—"}
          </div>
          <div>
            <span className="text-text-muted">Tipo:</span>{" "}
            <span
              className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                isAuto
                  ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200"
              }`}
            >
              {isAuto ? "Conciliado auto" : "Conciliado manual"}
            </span>
          </div>
        </div>

        {isAuto && (
          <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 p-2.5 text-xs mb-3">
            <strong>⚠ Atención:</strong> este es un match automático. Si después
            corrés "Re-evaluar todo" el motor puede volver a matchearlo igual.
            Para que el rechazo persista, vinculalo manualmente a otra cartola o
            dejá una nota en el detalle.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="btn-ghost"
            autoFocus
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="btn-primary bg-rose-600 hover:bg-rose-700"
          >
            {loading ? "Deshaciendo…" : "Sí, deshacer"}
          </button>
        </div>
      </div>
    </div>
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
