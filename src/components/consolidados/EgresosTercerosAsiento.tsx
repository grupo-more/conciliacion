"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";

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

  function exportXlsx() {
    if (!data || data.rows.length === 0) return;
    const aoa: (string | number)[][] = [
      ["Fecha", "Rubro", "Detalle", "Cuenta", "Glosa", "Debe", "Haber"],
    ];
    for (const r of data.rows) {
      aoa.push([
        formatDate(r.fecha),
        r.rubro ?? "",
        r.detalle,
        r.cuenta ?? "",
        r.glosa,
        r.debe ? Number(r.debe) : "",
        r.haber ? Number(r.haber) : "",
      ]);
    }
    aoa.push(["", "", "", "", "TOTAL", Number(totals.debe), Number(totals.haber)]);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 26 }, { wch: 18 }, { wch: 40 }, { wch: 14 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "EgresosTerceros");
    XLSX.writeFile(wb, `egresos_terceros_${from}_${to}.xlsx`);
  }

  return (
    <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
      <div className="flex justify-end p-2 border-b border-border-soft">
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
    </div>
  );
}
