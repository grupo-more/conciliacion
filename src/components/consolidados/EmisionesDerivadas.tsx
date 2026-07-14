"use client";

import { useEffect, useState } from "react";
import { formatDate, formatDateRangeEnd, formatMoney } from "@/lib/format";
import { exportAsi1Xls, type Asi1Linea, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";

/**
 * Emisiones para tabs de asiento DERIVADAS (OK, Abono Transbank, Dif menor,
 * Traspasos internos). El documento queda congelado en snapshot al emitir; los
 * movimientos consumidos salen del listado de la tab (y de nada más).
 *
 * - emitirDocumento(): POST del snapshot (las líneas exactas de la vista) +
 *   refIds; descarga el Excel al confirmar.
 * - <EmisionesPanel/>: lista de emisiones con Ver (preview del snapshot),
 *   Descargar (Excel exacto) y Deshacer (libera los movimientos).
 */

export type OrigenDerivado =
  | "OK"
  | "ABONO_TRANSBANK"
  | "DIF_MENOR"
  | "DIF_MENOR_EGRESO"
  | "TRASPASOS_INTERNOS";

interface EmisionDTO {
  id: string;
  folio: number;
  origen: string;
  desde: string;
  hasta: string;
  count: number;
  totalDebe: string;
  totalHaber: string;
  createdAt: string;
  snapshot?: {
    lineas: Asi1Linea[];
    fechaDoc: string;
    descripcion: string;
    filename: string;
  } | null;
}

export async function emitirDocumento(args: {
  origen: OrigenDerivado;
  from: string;
  to: string;
  asiento: { options: Asi1Options; filename: string };
  refIds: string[];
}): Promise<{ ok: true; folio: number } | { ok: false; error: string }> {
  const res = await fetch(`/api/consolidados/emisiones`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      origen: args.origen,
      from: args.from,
      to: args.to,
      fechaDoc: String(args.asiento.options.fecha).slice(0, 10),
      descripcion: args.asiento.options.descripcion,
      filename: args.asiento.filename,
      lineas: args.asiento.options.lineas,
      refIds: args.refIds,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: j.error || "Error al emitir" };
  // Descargar el documento de inmediato (el mismo que quedó congelado).
  exportAsi1Xls(
    { ...args.asiento.options, descripcion: `${args.asiento.options.descripcion} · Emisión #${j.folio}` },
    `${args.asiento.filename}_emision_${j.folio}`,
  );
  return { ok: true, folio: j.folio };
}

export function EmisionesPanel({ origen }: { origen: OrigenDerivado }) {
  const [emisiones, setEmisiones] = useState<EmisionDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);

  async function load() {
    const res = await fetch(`/api/consolidados/emisiones?origen=${origen}`);
    setEmisiones(res.ok ? (await res.json()).emisiones ?? [] : []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origen]);

  async function fetchSnapshot(e: EmisionDTO): Promise<EmisionDTO["snapshot"] | null> {
    const res = await fetch(`/api/consolidados/emisiones?id=${e.id}`);
    if (!res.ok) {
      setErr("No se pudo cargar la emisión");
      return null;
    }
    const snap = (await res.json()).emision?.snapshot;
    if (!snap?.lineas) {
      setErr("La emisión no tiene documento guardado");
      return null;
    }
    return snap;
  }

  function snapToAsiento(e: EmisionDTO, snap: NonNullable<EmisionDTO["snapshot"]>) {
    return {
      options: {
        fecha: snap.fechaDoc,
        descripcion: `${snap.descripcion} · Emisión #${e.folio}`,
        lineas: snap.lineas,
      } as Asi1Options,
      filename: `${snap.filename}_emision_${e.folio}`,
    };
  }

  async function ver(e: EmisionDTO) {
    const snap = await fetchSnapshot(e);
    if (snap) setPreview(snapToAsiento(e, snap));
  }

  async function descargar(e: EmisionDTO) {
    const snap = await fetchSnapshot(e);
    if (!snap) return;
    const a = snapToAsiento(e, snap);
    exportAsi1Xls(a.options, a.filename);
  }

  async function deshacer(e: EmisionDTO) {
    if (
      !confirm(
        `Deshacer la emisión #${e.folio}? Sus ${e.count} movimiento(s) vuelven a aparecer en la vista. ` +
          `Hazlo solo si el documento NO fue ingresado al otro sistema (o fue revertido allá).`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/consolidados/emisiones?id=${e.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j.error || "Error al deshacer");
      else load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {err && (
        <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">
          {err}
          <button onClick={() => setErr(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {emisiones === null ? (
          <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
        ) : emisiones.length === 0 ? (
          <div className="text-center py-8 text-sm text-text-muted">
            No hay emisiones. Se crean con el botón <b>Emitir documento</b> de esta tab.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Folio</th>
                  <th className="px-3 py-2 text-left">Emitida</th>
                  <th className="px-3 py-2 text-left">Rango</th>
                  <th className="px-3 py-2 text-right">Movs</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                  <th className="px-3 py-2 text-center">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {emisiones.map((e) => (
                  <tr key={e.id} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
                    <td className="px-3 py-2 font-mono font-bold whitespace-nowrap">#{e.folio}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-text-muted">
                      {formatDate(e.desde)} → {formatDateRangeEnd(e.hasta)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{e.count}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">${formatMoney(BigInt(e.totalDebe))}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">${formatMoney(BigInt(e.totalHaber))}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <button onClick={() => ver(e)} className="text-brand hover:underline text-xs font-semibold mr-3" title="Ver el documento exacto emitido (con imprimir y descargar)">
                        Ver
                      </button>
                      <button onClick={() => descargar(e)} className="text-brand hover:underline text-xs font-semibold mr-3" title="Re-descargar el Excel ASI1 exacto de esta emisión">
                        Descargar
                      </button>
                      <button onClick={() => deshacer(e)} disabled={busy} className="text-rose-700 hover:underline text-xs font-semibold disabled:opacity-50" title="Los movimientos vuelven a aparecer en la vista">
                        Deshacer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview && (
        <Asi1PreviewModal options={preview.options} filename={preview.filename} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** Toggle "Por emitir | Emitidos" con el mismo estilo de las otras tabs. */
export function EmisionesToggle({
  emitidos,
  onChange,
}: {
  emitidos: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-sm">
      <button
        onClick={() => onChange(false)}
        className={`px-3 py-1.5 font-semibold ${!emitidos ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
      >
        Por emitir
      </button>
      <button
        onClick={() => onChange(true)}
        className={`px-3 py-1.5 font-semibold ${emitidos ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
      >
        Emitidos
      </button>
    </div>
  );
}
