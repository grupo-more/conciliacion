"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { usePermisos } from "@/lib/use-permisos";
import {
  exportAsi1Zip,
  exportAsi1MultiSheet,
  type Asi1Options,
  type Asi1ZipEntry,
} from "@/lib/asientos/exportAsi1";
import { printAsi1 } from "./Asi1Preview";

type AsientoSide = "DEBE" | "HABER";

interface AsientoLinea {
  rubro: number;
  cuenta: string | null;
  detalle: string;
  side: AsientoSide;
  debe: string | null;
  haber: string | null;
}
interface Movimiento {
  tbkTesoreriaId: string | null;
  transbankSaleId: string | null;
  fecha: string | null;
  opBoleta: string | null;
  medioPago: string | null;
  dynatech: string;
  transbankBruto: string;
  transbank: string;
  comisionApi: string;
  comisionCartola: string;
  difMonto: string;
  diferencia: string;
}
interface SucursalAsiento {
  sucursalId: number;
  sucursalName: string | null;
  sucursalCodigo: number | null;
  dynatech: string;
  transbank: string;
  comisionApi: string;
  comisionCartola: string;
  diferencia: string;
  count: number;
  lineas: AsientoLinea[];
  movimientos: Movimiento[];
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
    comisionApi: string;
    comisionCartola: string;
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
interface Apartado {
  id: string;
  sucursalId: number;
  sucursalName: string | null;
  sucursalCodigo: number | null;
  fecha: string | null;
  opBoleta: string | null;
  medioPago: string | null;
  montoDynatech: string;
  montoTransbank: string;
  montoComision: string;
  motivo: string | null;
  createdAt: string;
  expiresAt: string;
  recuperable: boolean;
}

function money(s: string | null) {
  if (s == null) return "";
  return formatMoney(BigInt(s));
}

/** Monto con signo: +$X / -$X. */
function signed(s: string) {
  const n = BigInt(s);
  const a = n < 0n ? -n : n;
  return `${n < 0n ? "-" : "+"}$${formatMoney(a)}`;
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
  const { can } = usePermisos();
  const [vista, setVista] = useState<"pendiente" | "generadas" | "papelera">("pendiente");
  const [data, setData] = useState<PreviewResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const [cuads, setCuads] = useState<Cuadratura[] | null>(null);
  const [detalle, setDetalle] = useState<{ cuadratura: Cuadratura; asiento: Asiento } | null>(null);
  const [apartados, setApartados] = useState<Apartado[] | null>(null);

  // silent=true refresca los datos SIN el spinner de carga, para no desmontar la
  // tabla (así no se colapsa la sucursal abierta ni se pierde el scroll al
  // apartar una fila). El spinner solo se muestra en la carga inicial / cambios
  // de filtro.
  const loadPreview = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, mode: "preview" });
      if (sucursalId) p.set("sucursalId", sucursalId);
      const res = await fetch(`/api/consolidados/cruce-transbank/asiento?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      if (!silent) setLoading(false);
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

  const loadPapelera = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/papelera`);
      setApartados(res.ok ? (await res.json()).apartados : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (vista === "pendiente") loadPreview();
    else if (vista === "generadas") loadGeneradas();
    else loadPapelera();
  }, [vista, loadPreview, loadGeneradas, loadPapelera]);

  async function onApartar(mov: Movimiento, suc: SucursalAsiento) {
    if (!mov.tbkTesoreriaId || !mov.transbankSaleId) return;
    const motivo = window.prompt(
      `Apartar a la papelera el movimiento ${mov.opBoleta ?? ""} de ${suc.sucursalName ?? `#${suc.sucursalId}`}.\n` +
        `Motivo (opcional). Aceptar para confirmar, Cancelar para abortar:`,
      "",
    );
    if (motivo === null) return; // canceló
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/papelera`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tbkTesoreriaId: mov.tbkTesoreriaId,
          transbankSaleId: mov.transbankSaleId,
          sucursalId: suc.sucursalId,
          sucursalName: suc.sucursalName,
          sucursalCodigo: suc.sucursalCodigo,
          fecha: mov.fecha,
          opBoleta: mov.opBoleta,
          medioPago: mov.medioPago,
          montoDynatech: mov.dynatech,
          montoTransbank: mov.transbank,
          montoComision: mov.comisionCartola,
          motivo: motivo.trim() || null,
        }),
      });
      const j = await res.json();
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al apartar" });
      else {
        setBanner({ kind: "ok", msg: "Movimiento enviado a la papelera." });
        loadPreview(true); // refresco silencioso: no colapsa la tabla ni mueve el scroll
      }
    } catch {
      setBanner({ kind: "err", msg: "Error de red al apartar" });
    } finally {
      setBusy(false);
    }
  }

  async function onRestaurar(id: string) {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/papelera?id=${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al restaurar" });
      else {
        setBanner({ kind: "ok", msg: "Movimiento restaurado a 'por cuadrar'." });
        loadPapelera();
      }
    } finally {
      setBusy(false);
    }
  }

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
          <button
            onClick={() => setVista("papelera")}
            className={`px-3 py-1.5 font-semibold ${vista === "papelera" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
          >
            Papelera
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
        <PreviewBlock
          data={data}
          busy={busy}
          onGenerar={onGenerar}
          canGenerar={can("generarAsientos")}
          onApartar={can("depurar") ? onApartar : undefined}
          from={from}
          to={to}
        />
      )}

      {!loading && vista === "generadas" && (
        <GeneradasBlock
          cuads={cuads}
          onOpen={(c) => openCuadratura(c.id, setDetalle)}
          onDeshacer={can("generarAsientos") ? onDeshacer : undefined}
          busy={busy}
        />
      )}

      {!loading && vista === "papelera" && (
        <PapeleraBlock
          apartados={apartados}
          onRestaurar={can("depurar") ? onRestaurar : undefined}
          busy={busy}
        />
      )}

      {detalle && (
        <CuadraturaModal
          detalle={detalle}
          onClose={() => setDetalle(null)}
          onDeshacer={can("generarAsientos") ? () => onDeshacer(detalle.cuadratura.id) : undefined}
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
  canGenerar,
  onApartar,
  from,
  to,
}: {
  data: PreviewResp;
  busy: boolean;
  onGenerar: () => void;
  canGenerar: boolean;
  onApartar?: (mov: Movimiento, suc: SucursalAsiento) => void;
  from: string;
  to: string;
}) {
  const a = data.asiento;
  const hasRows = a.sucursales.length > 0;

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
          {canGenerar && (
            <button
              onClick={onGenerar}
              disabled={!hasRows || busy}
              className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Generando…" : "Generar cuadratura"}
            </button>
          )}
        </div>
      </div>

      {hasRows && <AsientoTable asiento={a} onApartar={onApartar} />}
    </div>
  );
}

/* ============================ Tabla del asiento ============================ */

function AsientoTable({
  asiento,
  onApartar,
}: {
  asiento: Asiento;
  onApartar?: (mov: Movimiento, suc: SucursalAsiento) => void;
}) {
  const t = asiento.totals;
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-5">
      {/* Asiento por sucursal */}
      <div className="rounded-xl border border-border-soft overflow-hidden">
        <div className="bg-bg-soft px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Asiento por sucursal <span className="normal-case font-normal">· clic en la sucursal para ver los movimientos</span>
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
              {asiento.sucursales.map((s) => {
                const isOpen = open.has(s.sucursalId);
                return (
                  <Fragment key={s.sucursalId}>
                    {s.lineas.map((l, idx) => (
                      <tr
                        key={`${s.sucursalId}-${idx}`}
                        className={
                          "text-sm " +
                          (idx === 0 ? "border-t-2 border-border-soft/80 bg-white" : "bg-bg-soft/30")
                        }
                      >
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          {idx === 0 && (
                            <button
                              onClick={() => toggle(s.sucursalId)}
                              className="inline-flex items-center gap-1.5 font-semibold hover:text-brand"
                              title="Ver movimientos que componen este asiento"
                            >
                              <span className="text-text-muted">{isOpen ? "▾" : "▸"}</span>
                              {s.sucursalName ?? `#${s.sucursalId}`}
                              {s.sucursalCodigo != null && (
                                <span className="text-xs text-text-muted font-mono">({s.sucursalCodigo})</span>
                              )}
                              <span className="text-xs text-text-muted font-normal">· {s.count} mov</span>
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-mono">{l.rubro}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <SideBadge side={l.side} /> {l.detalle}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.debe)}</td>
                        <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{money(l.haber)}</td>
                      </tr>
                    ))}
                    {isOpen && (
                      <tr className="bg-sky-50/40">
                        <td colSpan={5} className="px-3 py-2">
                          <MovimientosDetalle
                            movimientos={s.movimientos}
                            onApartar={onApartar ? (m) => onApartar(m, s) : undefined}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot className="bg-bg-soft">
              <tr className="border-t-2 border-border-soft">
                <td className="px-3 py-2 font-semibold" colSpan={3}>
                  TOTAL
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(t.debe)}</td>
                <td className="px-3 py-2 text-right font-mono font-bold">{money(t.haber)}</td>
              </tr>
              {t.debe !== t.haber && (
                <tr className="bg-amber-50">
                  <td className="px-3 py-1.5 text-amber-800 text-xs" colSpan={3}>
                    ⚠ Diferencia Debe − Haber (ajustar donde corresponda)
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-amber-800 text-xs" colSpan={2}>
                    {signed((BigInt(t.debe) - BigInt(t.haber)).toString())}
                  </td>
                </tr>
              )}
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

function MovimientosDetalle({
  movimientos,
  onApartar,
}: {
  movimientos: Movimiento[];
  onApartar?: (mov: Movimiento) => void;
}) {
  if (movimientos.length === 0)
    return <div className="text-xs text-text-muted">Sin detalle de movimientos guardado.</div>;
  // Totales por columna (para no sumar a mano).
  const tot = movimientos.reduce(
    (a, m) => {
      const cApi = BigInt(m.comisionApi);
      const cCart = BigInt(m.comisionCartola);
      const c708 = cApi > 0n ? cApi : cCart;
      a.boleta += BigInt(m.dynatech);
      a.transbank += BigInt(m.transbankBruto);
      a.recargo += BigInt(m.difMonto);
      a.neto += BigInt(m.transbank);
      a.cartola += cCart;
      a.d1403 += BigInt(m.diferencia);
      a.favor += c708 - cCart;
      return a;
    },
    { boleta: 0n, transbank: 0n, recargo: 0n, neto: 0n, cartola: 0n, d1403: 0n, favor: 0n },
  );
  return (
    <div className="rounded-lg border border-sky-200 bg-white overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-sky-50 text-[10px] uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left">Fecha</th>
            <th className="px-2 py-1.5 text-left">OP / Boleta</th>
            <th className="px-2 py-1.5 text-left">Medio</th>
            <th className="px-2 py-1.5 text-right" title="Monto de la boleta (Dynatech)">Boleta</th>
            <th className="px-2 py-1.5 text-right" title="Monto liquidado por Transbank (bruto)">Transbank</th>
            <th className="px-2 py-1.5 text-right" title="Recargo de crédito (bruto − boleta) → va al rubro 708. Azul = esperado; rojo ⚠ = no calza (posible mal tipado).">Recargo (→708)</th>
            <th className="px-2 py-1.5 text-right" title="Total abono que llega al banco (rubro 200)">Neto</th>
            <th className="px-2 py-1.5 text-right" title="Comisión real cobrada por Transbank (cartola)">Com. cartola</th>
            <th className="px-2 py-1.5 text-right" title="Comisión de débito → rubro 1403 'Diferencia' (en crédito da 0)">1403</th>
            <th className="px-2 py-1.5 text-right" title="Lo que se gana en crédito (recargo − comisión real) → rubro 1403 'Diferencia a favor'">A favor</th>
            {onApartar && <th className="px-2 py-1.5 text-center">Acción</th>}
          </tr>
        </thead>
        <tbody>
          {movimientos.map((m, i) => {
            const dif = BigInt(m.diferencia); // → 1403 "Diferencia" (c708 − recargo = comisión débito)
            const delta = BigInt(m.difMonto); // Transbank bruto − boleta = recargo (→708)
            const recargoEsperado = BigInt(m.comisionApi); // comisión API (0 si no vino)
            const c708 = recargoEsperado > 0n ? recargoEsperado : BigInt(m.comisionCartola);
            const favor = c708 - BigInt(m.comisionCartola); // → 1403 "Diferencia a favor" (gana crédito)
            const anomalia = delta - recargoEsperado; // ≠0 ⇒ no calza con el recargo ⇒ mal tipado
            // Color del Recargo/Δ: gris si no hay; azul si es el recargo esperado;
            // rojo si difiere del recargo (posible error de tipeo).
            const deltaCls =
              delta === 0n ? "text-text-dim" : anomalia !== 0n ? "text-rose-600 font-bold" : "text-sky-700";
            return (
              <tr key={i} className="border-t border-sky-100">
                <td className="px-2 py-1 whitespace-nowrap">{m.fecha ? formatDate(m.fecha) : "—"}</td>
                <td className="px-2 py-1 whitespace-nowrap font-mono">{m.opBoleta ?? "—"}</td>
                <td className="px-2 py-1 whitespace-nowrap">{m.medioPago ?? "—"}</td>
                <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-slate-700">{money(m.dynatech)}</td>
                <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-slate-700">{money(m.transbankBruto)}</td>
                <td
                  className={"px-2 py-1 text-right font-mono whitespace-nowrap " + deltaCls}
                  title={
                    delta === 0n
                      ? "Sin diferencia"
                      : anomalia !== 0n
                        ? `No calza con el recargo esperado por ${signed(anomalia.toString())} — posible mal tipado`
                        : "Recargo de crédito (esperado)"
                  }
                >
                  {delta === 0n ? "—" : `${anomalia !== 0n ? "⚠ " : ""}${signed(m.difMonto)}`}
                </td>
                <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-emerald-700">{money(m.transbank)}</td>
                <td className="px-2 py-1 text-right font-mono whitespace-nowrap text-text-muted">{money(m.comisionCartola)}</td>
                <td
                  className={
                    "px-2 py-1 text-right font-mono whitespace-nowrap " +
                    (dif !== 0n ? "text-amber-700 font-semibold" : "text-text-dim")
                  }
                  title="Comisión de débito que va al 1403 (en crédito da 0)"
                >
                  {dif !== 0n ? money(m.diferencia) : "—"}
                </td>
                <td
                  className={
                    "px-2 py-1 text-right font-mono whitespace-nowrap " +
                    (favor !== 0n ? "text-sky-700 font-semibold" : "text-text-dim")
                  }
                  title="Lo que se gana en crédito (recargo − comisión real) → 1403 a favor"
                >
                  {favor !== 0n ? money(favor.toString()) : "—"}
                </td>
                {onApartar && (
                  <td className="px-2 py-1 text-center whitespace-nowrap">
                    <button
                      onClick={() => onApartar(m)}
                      className="text-rose-700 hover:underline"
                      title="Apartar este movimiento a la papelera (no entra al asiento)"
                    >
                      Apartar
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-sky-50 font-semibold border-t-2 border-sky-200">
          <tr>
            <td className="px-2 py-1.5 text-left" colSpan={3}>TOTAL ({movimientos.length})</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap">{money(tot.boleta.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap">{money(tot.transbank.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-sky-700">{money(tot.recargo.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-emerald-700">{money(tot.neto.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-text-muted">{money(tot.cartola.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-amber-700">{money(tot.d1403.toString())}</td>
            <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap text-sky-700">{money(tot.favor.toString())}</td>
            {onApartar && <td />}
          </tr>
        </tfoot>
      </table>
      <div className="px-2 py-1.5 text-[10px] text-text-muted border-t border-sky-100 flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="text-sky-700 font-bold">azul</span> = recargo de crédito (esperado)</span>
        <span><span className="text-rose-600 font-bold">rojo ⚠</span> = no calza con el recargo (posible mal tipado)</span>
        <span><span className="text-emerald-700 font-bold">verde</span> = neto al banco</span>
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
  onDeshacer?: (id: string) => void;
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
                {onDeshacer && (
                  <button
                    onClick={() => onDeshacer(c.id)}
                    disabled={busy}
                    className="ml-3 text-rose-700 hover:underline text-xs disabled:opacity-50"
                  >
                    Deshacer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ============================ Papelera ============================ */

function PapeleraBlock({
  apartados,
  onRestaurar,
  busy,
}: {
  apartados: Apartado[] | null;
  onRestaurar?: (id: string) => void;
  busy: boolean;
}) {
  if (!apartados) return null;
  if (apartados.length === 0)
    return (
      <div className="p-4 text-sm text-text-muted">
        La papelera está vacía. Los movimientos que apartes desde el desglose aparecen acá (con 30 días para
        restaurarlos).
      </div>
    );
  return (
    <div className="rounded-xl border border-border-soft overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Apartado</th>
            <th className="px-3 py-2 text-left">Sucursal</th>
            <th className="px-3 py-2 text-left">OP / Boleta</th>
            <th className="px-3 py-2 text-right">Dynatech</th>
            <th className="px-3 py-2 text-right">Transbank</th>
            <th className="px-3 py-2 text-left">Motivo</th>
            <th className="px-3 py-2 text-left">Estado</th>
            <th className="px-3 py-2 text-center">Acción</th>
          </tr>
        </thead>
        <tbody>
          {apartados.map((a) => (
            <tr key={a.id} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
              <td className="px-3 py-2 whitespace-nowrap text-text-muted">{formatDate(a.createdAt)}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {a.sucursalName ?? `#${a.sucursalId}`}
                {a.sucursalCodigo != null && (
                  <span className="ml-1 text-xs text-text-muted font-mono">({a.sucursalCodigo})</span>
                )}
              </td>
              <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{a.opBoleta ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono">{money(a.montoDynatech)}</td>
              <td className="px-3 py-2 text-right font-mono">{money(a.montoTransbank)}</td>
              <td className="px-3 py-2 max-w-[220px] truncate" title={a.motivo ?? ""}>
                {a.motivo || <span className="text-text-dim">—</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {a.recuperable ? (
                  <span className="text-xs text-text-muted">
                    Recuperable hasta <b>{formatDate(a.expiresAt)}</b>
                  </span>
                ) : (
                  <span className="inline-block rounded-full bg-zinc-100 text-zinc-700 border border-zinc-200 px-2 py-0.5 text-[11px] font-semibold">
                    Definitivo
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-center whitespace-nowrap">
                {a.recuperable && onRestaurar ? (
                  <button
                    onClick={() => onRestaurar(a.id)}
                    disabled={busy}
                    className="text-brand hover:underline text-xs disabled:opacity-50"
                  >
                    Restaurar
                  </button>
                ) : (
                  <span className="text-text-dim text-xs">—</span>
                )}
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
  onDeshacer?: () => void;
  busy: boolean;
}) {
  const { cuadratura: c, asiento } = detalle;
  const periodo = `${formatDate(c.desde)} al ${formatDate(c.hasta)}`;
  const stamp = `${c.desde.slice(0, 10)}_${c.hasta.slice(0, 10)}`;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Cuadratura {formatDate(c.desde)} → {formatDate(c.hasta)}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => printAsi1(consolidacionOptions(asiento, c.hasta, periodo))}
              className="btn-ghost text-sm"
            >
              Imprimir
            </button>
            <button
              onClick={() => descargarTodoZip(asiento, c.hasta, periodo, `cuadratura_${stamp}`)}
              className="btn-ghost text-sm"
              title="ZIP con un asiento por sucursal + la consolidación (para importar de a uno)"
            >
              Descargar todo (ZIP)
            </button>
            <button
              onClick={() => descargarAuditoria(asiento, c.hasta, periodo, `cuadratura_auditoria_${stamp}`)}
              className="btn-ghost text-sm"
              title="Un Excel con todas las sucursales + consolidación (para auditar)"
            >
              Auditar
            </button>
            {onDeshacer && (
              <button onClick={onDeshacer} disabled={busy} className="btn-ghost text-sm text-rose-700">
                Deshacer
              </button>
            )}
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

/* ---- Separación por sucursal + consolidación (ZIP) y auditoría (multi-hoja) ---- */

// En los .xls que van a gestión, la Descripción de CADA línea es la glosa del
// período ("Cuadratura transbank del X al Y"), no el nombre del rubro que se
// muestra en pantalla (Ventas/Tesorería/...) — pedido de contabilidad.
const glosaPeriodo = (periodo: string) => `Cuadratura transbank del ${periodo}`;

const mapLineas = (lineas: AsientoLinea[], glosa: string): Asi1Options["lineas"] =>
  lineas.map((l) => ({ rubro: l.rubro, detalle: glosa, debe: l.debe, haber: l.haber }));

/** Opciones ASI1 del asiento de UNA sucursal. */
function sucursalOptions(s: SucursalAsiento, fecha: string, periodo: string): Asi1Options {
  const nombre = s.sucursalName ?? `#${s.sucursalId}`;
  return {
    fecha,
    descripcion: `Cuadratura Transbank ${nombre} ${periodo}`,
    // El sucursalId del POS (Dynatech) coincide con el nº de sucursal de
    // gestión (ej. 9 = Iquique) → va en la celda "Sucursal:" del header.
    // sucursalCodigo puede venir null en snapshots viejos (maestro sin match);
    // sucursalId es el mismo id POS, así que sirve igual.
    sucursal: s.sucursalCodigo ?? s.sucursalId,
    lineas: mapLineas(s.lineas, glosaPeriodo(periodo)),
  };
}

/** Opciones ASI1 del asiento de consolidación. */
function consolidacionOptions(a: Asiento, fecha: string, periodo: string): Asi1Options {
  return {
    fecha,
    descripcion: `Cuadratura Transbank consolidación ${periodo}`,
    lineas: mapLineas(a.consolidacion.lineas, glosaPeriodo(periodo)),
  };
}

function slug(s: string): string {
  return (s || "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "sucursal";
}

/** ZIP: un .xls ASI1 por sucursal + uno de consolidación (para importar de a uno). */
function descargarTodoZip(a: Asiento, fecha: string, periodo: string, zipName: string) {
  const entries: Asi1ZipEntry[] = a.sucursales.map((s) => ({
    options: sucursalOptions(s, fecha, periodo),
    filename: `sucursal_${s.sucursalCodigo ?? s.sucursalId}_${slug(s.sucursalName ?? "")}`,
  }));
  entries.push({ options: consolidacionOptions(a, fecha, periodo), filename: "consolidacion" });
  return exportAsi1Zip(entries, zipName);
}

/** Excel multi-hoja (una por sucursal + consolidación) — solo para auditar. */
function descargarAuditoria(a: Asiento, fecha: string, periodo: string, filename: string) {
  const sheets = a.sucursales.map((s) => ({
    name: s.sucursalName ?? `Suc ${s.sucursalId}`,
    options: sucursalOptions(s, fecha, periodo),
  }));
  sheets.push({ name: "Consolidacion", options: consolidacionOptions(a, fecha, periodo) });
  exportAsi1MultiSheet(sheets, filename);
}
