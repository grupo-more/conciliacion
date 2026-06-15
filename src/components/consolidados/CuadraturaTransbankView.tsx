"use client";

import { useCallback, useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";

type AsientoSide = "DEBE" | "HABER";

interface AsientoLinea {
  rubro: number;
  cuenta: string | null;
  detalle: string;
  side: AsientoSide;
  debe: string | null;
  haber: string | null;
}
interface SucursalAsiento {
  sucursalId: number;
  sucursalName: string | null;
  sucursalCodigo: number | null;
  dynatech: string;
  transbank: string;
  comision: string;
  diferencia: string;
  count: number;
  lineas: AsientoLinea[];
}
interface Consolidacion {
  lineas: AsientoLinea[];
  totalDebe: string;
  totalHaber: string;
  balanceado: boolean;
}
interface Asiento {
  sucursales: SucursalAsiento[];
  consolidacion: Consolidacion;
  totals: {
    dynatech: string;
    transbank: string;
    comision: string;
    diferencia: string;
    debe: string;
    haber: string;
  };
}
interface Settings {
  rubroVentas: number;
  rubroTesoreria: number;
  rubroComision: number;
  rubroDiferencia: number;
}
interface PreviewResp {
  from: string;
  to: string;
  settings: Settings;
  pendingCount: number;
  asiento: Asiento;
  facets: { sucursales: { id: number; name: string | null }[] };
}
interface Cuadratura {
  id: string;
  desde: string;
  hasta: string;
  glosa: string | null;
  createdAt: string;
  itemCount: number;
  totalDynatech: string;
  totalTransbank: string;
  totalComision: string;
  totalDiferencia: string;
}

function money(s: string | null) {
  if (s == null) return "";
  return formatMoney(BigInt(s));
}

/**
 * Subtab "Conciliados (asiento)" de Cruce Transbank: arma el asiento de
 * cuadratura por sucursal (rubros configurables 17/200/708/1403) de los
 * movimientos cuadrados pendientes, y permite generar la cuadratura (que los
 * marca como consumidos) o ver/deshacer las ya generadas.
 */
export function CuadraturaTransbankView({
  from,
  to,
  sucursalId,
}: {
  from: string;
  to: string;
  sucursalId: string;
}) {
  const [vista, setVista] = useState<"pendiente" | "generadas">("pendiente");
  const [data, setData] = useState<PreviewResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const [cuads, setCuads] = useState<Cuadratura[] | null>(null);
  const [detalle, setDetalle] = useState<{ cuadratura: Cuadratura; asiento: Asiento } | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, mode: "preview" });
      if (sucursalId) p.set("sucursalId", sucursalId);
      const res = await fetch(`/api/consolidados/cruce-transbank/asiento?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }, [from, to, sucursalId]);

  const loadGeneradas = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, mode: "generadas" });
      const res = await fetch(`/api/consolidados/cruce-transbank/asiento?${p}`);
      setCuads(res.ok ? (await res.json()).cuadraturas : []);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (vista === "pendiente") loadPreview();
    else loadGeneradas();
  }, [vista, loadPreview, loadGeneradas]);

  async function onGenerar() {
    if (!data || data.pendingCount === 0) return;
    if (!confirm(`Generar la cuadratura de ${data.pendingCount} movimiento(s)? Quedarán marcados y no se volverán a considerar.`))
      return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/asiento`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, sucursalId: sucursalId ? Number(sucursalId) : null }),
      });
      const j = await res.json();
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al generar" });
      else {
        setBanner({ kind: "ok", msg: `Cuadratura generada: ${j.itemCount} movimiento(s) marcados.` });
        loadPreview();
      }
    } catch {
      setBanner({ kind: "err", msg: "Error de red al generar" });
    } finally {
      setBusy(false);
    }
  }

  async function onDeshacer(id: string) {
    if (!confirm("Deshacer esta cuadratura? Los movimientos volverán a quedar pendientes.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/asiento?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setDetalle(null);
        loadGeneradas();
      } else {
        const j = await res.json().catch(() => ({}));
        setBanner({ kind: "err", msg: j.error || "Error al deshacer" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-sm">
          <button
            onClick={() => setVista("pendiente")}
            className={`px-3 py-1.5 font-semibold ${vista === "pendiente" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
          >
            Por cuadrar
          </button>
          <button
            onClick={() => setVista("generadas")}
            className={`px-3 py-1.5 font-semibold ${vista === "generadas" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
          >
            Generadas
          </button>
        </div>
        {data?.settings && vista === "pendiente" && (
          <span className="text-xs text-text-muted">
            Rubros: ventas <b>{data.settings.rubroVentas}</b> · tesorería <b>{data.settings.rubroTesoreria}</b> · comisión{" "}
            <b>{data.settings.rubroComision}</b> · diferencia <b>{data.settings.rubroDiferencia}</b>
          </span>
        )}
      </div>

      {banner && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            banner.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
              : "bg-rose-50 text-rose-800 border border-rose-200"
          }`}
        >
          {banner.msg}
          <button onClick={() => setBanner(null)} className="ml-2 underline">
            cerrar
          </button>
        </div>
      )}

      {loading && <div className="p-4 text-sm text-text-muted">Cargando…</div>}

      {!loading && vista === "pendiente" && data && (
        <PreviewBlock data={data} busy={busy} onGenerar={onGenerar} from={from} to={to} />
      )}

      {!loading && vista === "generadas" && (
        <GeneradasBlock cuads={cuads} onOpen={(c) => openCuadratura(c.id, setDetalle)} onDeshacer={onDeshacer} busy={busy} />
      )}

      {detalle && (
        <CuadraturaModal
          detalle={detalle}
          onClose={() => setDetalle(null)}
          onDeshacer={() => onDeshacer(detalle.cuadratura.id)}
          busy={busy}
        />
      )}
    </div>
  );
}

async function openCuadratura(
  id: string,
  setDetalle: (d: { cuadratura: Cuadratura; asiento: Asiento } | null) => void,
) {
  const res = await fetch(`/api/consolidados/cruce-transbank/asiento?cuadraturaId=${id}`);
  if (res.ok) setDetalle(await res.json());
}

/* ============================ Preview (por cuadrar) ============================ */

function PreviewBlock({
  data,
  busy,
  onGenerar,
  from,
  to,
}: {
  data: PreviewResp;
  busy: boolean;
  onGenerar: () => void;
  from: string;
  to: string;
}) {
  const a = data.asiento;
  const hasRows = a.sucursales.length > 0;

  function exportXlsx() {
    exportAsientoXlsx(a, `cuadratura_transbank_${from}_${to}`);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-text-muted">
          {data.pendingCount > 0 ? (
            <>
              <b className="text-text">{data.pendingCount}</b> movimiento(s) cuadrado(s) por llevar a asiento ·{" "}
              <b>{a.sucursales.length}</b> sucursal(es)
            </>
          ) : (
            "No hay movimientos cuadrados pendientes en el rango."
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={exportXlsx} disabled={!hasRows} className="btn-ghost text-sm">
            Descargar Excel
          </button>
          <button
            onClick={onGenerar}
            disabled={!hasRows || busy}
            className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Generando…" : "Generar cuadratura"}
          </button>
        </div>
      </div>

      {hasRows && <AsientoTable asiento={a} />}
    </div>
  );
}

/* ============================ Tabla del asiento ============================ */

function AsientoTable({ asiento }: { asiento: Asiento }) {
  const t = asiento.totals;
  return (
    <div className="space-y-5">
      {/* Asiento por sucursal */}
      <div className="rounded-xl border border-border-soft overflow-hidden">
        <div className="bg-bg-soft px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Asiento por sucursal
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Sucursal</th>
                <th className="px-3 py-2 text-left">Rubro</th>
                <th className="px-3 py-2 text-left">Detalle</th>
                <th className="px-3 py-2 text-right">Debe</th>
                <th className="px-3 py-2 text-right">Haber</th>
              </tr>
            </thead>
            <tbody>
              {asiento.sucursales.map((s) =>
                s.lineas.map((l, idx) => (
                  <tr
                    key={`${s.sucursalId}-${idx}`}
                    className={"text-sm " + (idx === 0 ? "border-t-2 border-border-soft/80 bg-white" : "bg-bg-soft/30")}
                  >
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {idx === 0 ? (
                        <span>
                          {s.sucursalName ?? `#${s.sucursalId}`}
                          {s.sucursalCodigo != null && (
                            <span className="ml-1 text-xs text-text-muted font-mono">({s.sucursalCodigo})</span>
                          )}
                        </span>
                      ) : (
                        ""
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-mono">{l.rubro}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <SideBadge side={l.side} /> {l.detalle}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.debe)}</td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.haber)}</td>
                  </tr>
                )),
              )}
            </tbody>
            <tfoot className="bg-bg-soft">
              <tr className="border-t-2 border-border-soft">
                <td className="px-3 py-2 font-semibold" colSpan={3}>
                  TOTAL
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(t.debe)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(t.haber)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Asiento de consolidación */}
      <div className="rounded-xl border border-border-soft overflow-hidden">
        <div className="bg-bg-soft px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center justify-between">
          <span>Asiento de consolidación</span>
          {!asiento.consolidacion.balanceado && (
            <span
              className="rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 text-[10px] font-bold normal-case"
              title="Según el correo, el debe (total ventas) y el haber (total tesorería por sucursal) no necesariamente cuadran. Revisar."
            >
              ⚠ Debe ≠ Haber
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Rubro / Sucursal</th>
                <th className="px-3 py-2 text-left">Detalle</th>
                <th className="px-3 py-2 text-right">Debe</th>
                <th className="px-3 py-2 text-right">Haber</th>
              </tr>
            </thead>
            <tbody>
              {asiento.consolidacion.lineas.map((l, idx) => (
                <tr key={idx} className="border-t border-border-soft/60">
                  <td className="px-3 py-1.5 whitespace-nowrap font-mono">
                    {l.rubro}
                    {l.cuenta && <span className="ml-2 font-sans text-text-muted">{l.cuenta}</span>}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <SideBadge side={l.side} /> {l.detalle}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.debe)}</td>
                  <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.haber)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-bg-soft">
              <tr className="border-t-2 border-border-soft">
                <td className="px-3 py-2 font-semibold" colSpan={2}>
                  TOTAL
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(asiento.consolidacion.totalDebe)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(asiento.consolidacion.totalHaber)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function SideBadge({ side }: { side: AsientoSide }) {
  const isDebe = side === "DEBE";
  return (
    <span
      className={`mr-1 inline-block rounded-full text-[10px] px-1.5 py-0.5 font-bold ${
        isDebe ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800"
      }`}
    >
      {side}
    </span>
  );
}

/* ============================ Generadas (historial) ============================ */

function GeneradasBlock({
  cuads,
  onOpen,
  onDeshacer,
  busy,
}: {
  cuads: Cuadratura[] | null;
  onOpen: (c: Cuadratura) => void;
  onDeshacer: (id: string) => void;
  busy: boolean;
}) {
  if (!cuads) return null;
  if (cuads.length === 0)
    return <div className="p-4 text-sm text-text-muted">No hay cuadraturas generadas en el rango.</div>;
  return (
    <div className="rounded-xl border border-border-soft overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Generada</th>
            <th className="px-3 py-2 text-left">Rango</th>
            <th className="px-3 py-2 text-right">Movs</th>
            <th className="px-3 py-2 text-right">Dynatech</th>
            <th className="px-3 py-2 text-right">Transbank</th>
            <th className="px-3 py-2 text-right">Comisión</th>
            <th className="px-3 py-2 text-center">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {cuads.map((c) => (
            <tr key={c.id} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
              <td className="px-3 py-2 whitespace-nowrap">{formatDate(c.createdAt)}</td>
              <td className="px-3 py-2 whitespace-nowrap text-text-muted">
                {formatDate(c.desde)} → {formatDate(c.hasta)}
              </td>
              <td className="px-3 py-2 text-right font-mono">{c.itemCount}</td>
              <td className="px-3 py-2 text-right font-mono">{money(c.totalDynatech)}</td>
              <td className="px-3 py-2 text-right font-mono">{money(c.totalTransbank)}</td>
              <td className="px-3 py-2 text-right font-mono text-text-muted">{money(c.totalComision)}</td>
              <td className="px-3 py-2 text-center whitespace-nowrap">
                <button onClick={() => onOpen(c)} className="text-brand hover:underline text-xs">
                  Ver
                </button>
                <button
                  onClick={() => onDeshacer(c.id)}
                  disabled={busy}
                  className="ml-3 text-rose-700 hover:underline text-xs disabled:opacity-50"
                >
                  Deshacer
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CuadraturaModal({
  detalle,
  onClose,
  onDeshacer,
  busy,
}: {
  detalle: { cuadratura: Cuadratura; asiento: Asiento };
  onClose: () => void;
  onDeshacer: () => void;
  busy: boolean;
}) {
  const { cuadratura: c, asiento } = detalle;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Cuadratura {formatDate(c.desde)} → {formatDate(c.hasta)}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => exportAsientoXlsx(asiento, `cuadratura_${c.id.slice(0, 8)}`)}
              className="btn-ghost text-sm"
            >
              Excel
            </button>
            <button onClick={onDeshacer} disabled={busy} className="btn-ghost text-sm text-rose-700">
              Deshacer
            </button>
            <button onClick={onClose} className="btn-ghost text-sm">
              Cerrar
            </button>
          </div>
        </div>
        <AsientoTable asiento={asiento} />
      </div>
    </div>
  );
}

/* ============================ Export Excel ============================ */

function exportAsientoXlsx(a: Asiento, filename: string) {
  const aoa: (string | number)[][] = [["Sucursal", "Rubro", "Lado", "Detalle", "Debe", "Haber"]];
  for (const s of a.sucursales) {
    s.lineas.forEach((l, idx) => {
      aoa.push([
        idx === 0 ? s.sucursalName ?? `#${s.sucursalId}` : "",
        l.rubro,
        l.side,
        l.detalle,
        l.debe ? Number(l.debe) : "",
        l.haber ? Number(l.haber) : "",
      ]);
    });
  }
  aoa.push(["", "", "", "TOTAL", Number(a.totals.debe), Number(a.totals.haber)]);
  aoa.push([]);
  aoa.push(["CONSOLIDACIÓN", "", "", "", "", ""]);
  aoa.push(["Rubro/Sucursal", "Rubro", "Lado", "Detalle", "Debe", "Haber"]);
  for (const l of a.consolidacion.lineas) {
    aoa.push([l.cuenta ?? "", l.rubro, l.side, l.detalle, l.debe ? Number(l.debe) : "", l.haber ? Number(l.haber) : ""]);
  }
  aoa.push(["", "", "", "TOTAL", Number(a.consolidacion.totalDebe), Number(a.consolidacion.totalHaber)]);

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = [{ wch: 20 }, { wch: 8 }, { wch: 8 }, { wch: 22 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Cuadratura");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}
