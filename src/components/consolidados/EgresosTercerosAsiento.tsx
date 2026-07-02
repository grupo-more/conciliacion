"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";

interface AsientoRowDTO {
  groupId: string;
  side: "GASTO" | "BANCO";
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  cuenta: string | null;
  glosa: string;
  debe: string | null;
  haber: string | null;
  status: string;
  egresoExternalId: string;
  bankMovementId: string | null;
}

interface AsientoResp {
  from: string;
  to: string;
  rows: AsientoRowDTO[];
  totals: { debe: string; haber: string };
  facets: { accounts: { id: string; label: string }[] };
}

/**
 * Sub-vista "Conciliados" de Egresos a terceros: asiento de partida doble
 * (DEBE rubro gasto / HABER cuenta banco) de las conciliaciones EgresoMovement
 * ↔ banco OUT. Raíz (banco) y destino (gasto). Espeja OKView.
 */
export function EgresosTercerosAsiento({
  from,
  to,
  accountId,
}: {
  from: string;
  to: string;
  accountId: string;
}) {
  const [data, setData] = useState<AsientoResp | null>(null);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams({ from, to });
        if (accountId) p.set("accountId", accountId);
        const res = await fetch(`/api/consolidados/egresos-terceros/asiento?${p}`);
        if (!cancel) setData(res.ok ? await res.json() : null);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [from, to, accountId]);

  const totals = useMemo(
    () => ({
      debe: data ? BigInt(data.totals.debe) : 0n,
      haber: data ? BigInt(data.totals.haber) : 0n,
    }),
    [data],
  );

  const hasRows = data && data.rows.length > 0;

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (!data || data.rows.length === 0) return null;
    return {
      options: {
        fecha: to,
        descripcion: `Egresos a terceros ${formatDate(from)} al ${formatDate(to)}`,
        lineas: data.rows.map((r) => ({
          rubro: r.rubro ?? "",
          detalle: r.detalle,
          debe: r.debe,
          haber: r.haber,
        })),
      },
      filename: `egresos_terceros_${from}_${to}`,
    };
  }

  function exportXlsx() {
    const a = buildAsiento();
    if (a) exportAsi1Xls(a.options, a.filename);
  }

  return (
    <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
      <div className="flex justify-end gap-2 p-2 border-b border-border-soft">
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
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          Descargar Excel
        </button>
      </div>
      {loading && <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>}
      {!loading && !hasRows && (
        <div className="text-center py-8 text-sm text-text-muted">
          No hay egresos a terceros conciliados en este rango. Corré "Re-evaluar todo" o vinculá manualmente desde la vista Pendientes.
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
                <th className="px-3 py-2 text-left">Cuenta</th>
                <th className="px-3 py-2 text-left">Glosa</th>
                <th className="px-3 py-2 text-right">Debe</th>
                <th className="px-3 py-2 text-right">Haber</th>
              </tr>
            </thead>
            <tbody>
              {data!.rows.map((r, idx) => {
                const prev = idx > 0 ? data!.rows[idx - 1] : null;
                const isGroupStart = !prev || prev.groupId !== r.groupId;
                const isBanco = r.side === "BANCO";
                return (
                  <tr
                    key={`${r.groupId}-${r.side}-${idx}`}
                    className={
                      "text-sm " +
                      (isGroupStart ? "border-t-2 border-border-soft/80 bg-white " : "bg-bg-soft/40 ")
                    }
                  >
                    <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
                      {isGroupStart ? formatDate(r.fecha) : ""}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono">{r.rubro ?? "—"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span
                        className={`mr-1.5 inline-block rounded-full text-[10px] px-1.5 py-0.5 font-bold ${
                          isBanco ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"
                        }`}
                      >
                        {isBanco ? "BANCO" : "GASTO"}
                      </span>
                      {r.detalle}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{r.cuenta ?? "—"}</td>
                    <td className="px-3 py-1.5 max-w-[320px] truncate" title={r.glosa}>{r.glosa}</td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                      {r.debe ? formatMoney(BigInt(r.debe)) : ""}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                      {r.haber ? formatMoney(BigInt(r.haber)) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-bg-soft">
              <tr className="border-t-2 border-border-soft">
                <td className="px-3 py-2 font-semibold" colSpan={5}>TOTAL</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{formatMoney(totals.debe)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{formatMoney(totals.haber)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
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
