"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, pickDescripcion, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";
import {
  EmisionesPanel,
  EmisionesToggle,
  emitirDocumento,
} from "./EmisionesDerivadas";
import { usePermisos } from "@/lib/use-permisos";

interface AbonoConciliadoRow {
  groupId: string;
  side: "DEBE" | "HABER";
  fecha: string;
  rubro: number;
  rubroLabel: string | null;
  detalle: string;
  sucursal: string | null;
  glosa: string;
  debe: string | null;
  haber: string | null;
  transbankSaleId: string;
  neto: string;
}

interface AbonosConciliadosResponse {
  from: string;
  to: string;
  settings: { rubroDebe: number; rubroHaber: number };
  rows: AbonoConciliadoRow[];
  totals: { debe: string; haber: string };
}

/**
 * Subtab "Abonos conciliados" de Cruce Transbank: abonos/cargos del settlement
 * que no corresponden a operaciones de la empresa (nunca tendrán POS),
 * derivados a mano desde Movimientos con la acción "Abono conciliado". Se contabilizan por el
 * NETO, siempre Debe rubroDebe / Haber rubroHaber (un cargo queda negativo, no
 * se invierte). Rubros editables en Configuración → Abonos Transbank.
 * Resolución vía emisión (folio), como Dif menor. "Devolver" deshace la marca.
 */
export function AbonosConciliadosView({
  from,
  to,
  sucursalId,
}: {
  from: string;
  to: string;
  sucursalId: string;
}) {
  const { can } = usePermisos();
  const puedeConciliar = can("conciliar");

  const [data, setData] = useState<AbonosConciliadosResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [verEmitidos, setVerEmitidos] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (sucursalId) p.set("sucursalId", sucursalId);
      const res = await fetch(`/api/consolidados/cruce-transbank/abonos-conciliados?${p}`);
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
  }, [from, to, sucursalId]);

  const totals = useMemo(() => {
    if (!data) return { debe: 0n, haber: 0n };
    return { debe: BigInt(data.totals.debe), haber: BigInt(data.totals.haber) };
  }, [data]);

  const hasRows = !!data && data.rows.length > 0;
  const abonosCount = data ? data.rows.length / 2 : 0;

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (!data || data.rows.length === 0) return null;
    return {
      options: {
        fecha: to,
        descripcion: `Abonos Transbank conciliados ${formatDate(from)} al ${formatDate(to)}`,
        lineas: data.rows.map((r) => ({
          rubro: r.rubro,
          detalle: pickDescripcion(r.sucursal ?? "", r.glosa, r.detalle),
          debe: r.debe,
          haber: r.haber,
        })),
      },
      filename: `abonos_conciliados_${from}_${to}`,
    };
  }

  async function emitir() {
    const a = buildAsiento();
    if (!a || !data) return;
    const refIds = Array.from(new Set(data.rows.map((r) => r.transbankSaleId)));
    if (
      !confirm(
        `Se emitirán ${refIds.length} abono(s) conciliado(s) como un documento con folio nuevo. ` +
          `Saldrán de esta vista y quedarán en "Emitidos" (re-descargables, deshacer disponible). ¿Continuar?`,
      )
    )
      return;
    setEmitiendo(true);
    setErr(null);
    try {
      const r = await emitirDocumento({ origen: "ABONO_CONCILIADO", from, to, asiento: a, refIds });
      if (!r.ok) setErr(r.error);
      else load();
    } finally {
      setEmitiendo(false);
    }
  }

  /** Devuelve un abono a Movimientos (deshace la derivación). */
  async function devolver(transbankSaleId: string) {
    if (!confirm("¿Devolver este abono a Movimientos? Volverá a aparecer como Settlement sin POS.")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/consolidados/cruce-transbank/abonos-conciliados", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transbankSaleIds: [transbankSaleId] }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setErr(d.error || "Error al devolver");
      else {
        if (d.bloqueados?.length > 0) alert(d.mensaje);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  if (verEmitidos) {
    return (
      <div className="space-y-4">
        <EmisionesToggle emitidos onChange={setVerEmitidos} />
        <EmisionesPanel origen="ABONO_CONCILIADO" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <EmisionesToggle emitidos={false} onChange={setVerEmitidos} />
        <span className="text-xs text-text-muted">
          Asiento: Debe <strong>{data?.settings.rubroDebe ?? 200}</strong> / Haber{" "}
          <strong>{data?.settings.rubroHaber ?? 1403}</strong> por el neto (rubros editables en
          Configuración → Abonos Transbank)
          {hasRows && (
            <>
              {" · "}
              {abonosCount} abono{abonosCount === 1 ? "" : "s"}
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
          onClick={() => {
            const a = buildAsiento();
            if (a) exportAsi1Xls(a.options, a.filename);
          }}
          disabled={!hasRows}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm font-semibold hover:bg-bg-soft disabled:opacity-50"
        >
          Descargar Excel
        </button>
        <button
          onClick={emitir}
          disabled={!hasRows || emitiendo || !puedeConciliar}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          title="Descarga el documento y mueve estos abonos a Emitidos (documento ingresado al otro sistema)"
        >
          {emitiendo ? "Emitiendo…" : `Emitir documento${hasRows ? ` (${abonosCount})` : ""}`}
        </button>
      </div>

      {err && (
        <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">
          {err}
          <button onClick={() => setErr(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}

      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            No hay abonos conciliados por emitir en este rango. Se derivan desde
            Movimientos con la acción &quot;Abono conciliado&quot; (filas Settlement sin POS).
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
                  <th className="px-3 py-2 text-left">Sucursal</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                  <th className="px-3 py-2 text-center">Acción</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const prev = idx > 0 ? data!.rows[idx - 1] : null;
                  const isGroupStart = !prev || prev.groupId !== r.groupId;
                  return (
                    <tr
                      key={`${r.groupId}-${r.side}`}
                      className={
                        "text-sm " +
                        (isGroupStart ? "border-t-2 border-border-soft/80 bg-white" : "bg-bg-soft/40")
                      }
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
                        {isGroupStart ? formatDate(r.fecha) : ""}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono">{r.rubro}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{r.detalle}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {isGroupStart ? r.sucursal ?? "—" : ""}
                      </td>
                      <td className="px-3 py-1.5 max-w-[320px] truncate" title={r.glosa}>
                        {r.glosa}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                        {r.debe ? formatMoney(BigInt(r.debe)) : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                        {r.haber ? formatMoney(BigInt(r.haber)) : ""}
                      </td>
                      <td className="px-3 py-1.5 text-center whitespace-nowrap">
                        {isGroupStart && puedeConciliar && (
                          <button
                            onClick={() => devolver(r.transbankSaleId)}
                            disabled={busy}
                            className="text-rose-700 hover:underline text-xs disabled:opacity-50"
                            title="Devolver a Movimientos (vuelve a Settlement sin POS)"
                          >
                            Devolver
                          </button>
                        )}
                      </td>
                    </tr>
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
                  <td />
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
