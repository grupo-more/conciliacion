"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import { CuadraturaTransbankView } from "./CuadraturaTransbankView";
import { AbonosConciliadosView } from "./AbonosConciliadosView";
import { usePermisos } from "@/lib/use-permisos";

type Estado = "cuadrado" | "pos_sin_settlement" | "settlement_sin_pos";

interface CruceRow {
  estado: Estado;
  fecha: string;
  sucursalId: number | null;
  sucursalName: string | null;
  op: string | null;
  glosa: string | null;
  medioPago: string | null;
  montoBruto: string;
  comision: string | null;
  neto: string | null;
  diferencia: string | null;
  diferenciaPct: number | null;
  tid: string | null;
  boleta: string | null;
  tbkTesoreriaId: string | null;
  transbankSaleId: string | null;
  /** N abonos cuadrados con este POS (2+ = pago dividido / multi-boleta). */
  settCount: number;
  manual: boolean;
  ficticio: boolean;
}

interface CruceResponse {
  from: string;
  to: string;
  kpis: {
    cuadrados: number;
    posSinSettlement: number;
    settlementSinPos: number;
    totalBruto: string;
    totalComision: string;
    totalNeto: string;
    conRecargo: number;
    totalRecargo: string;
  };
  rows: CruceRow[];
  rowsTotal: number;
  facets: { sucursales: { id: number; name: string | null }[] };
}

const ESTADO_META: Record<Estado, { label: string; cls: string }> = {
  cuadrado: { label: "Cuadrado", cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  pos_sin_settlement: { label: "POS sin settlement", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  settlement_sin_pos: { label: "Settlement sin POS", cls: "bg-rose-100 text-rose-800 border-rose-300" },
};

export function CruceTransbankView() {
  const { can, me } = usePermisos();
  const [from, setFrom] = useState<string>(firstDayOfMonthIso());
  const [to, setTo] = useState<string>(todayIso());
  const [sucursalId, setSucursalId] = useState<string>("");
  const [estado, setEstado] = useState<Estado | "">("");
  const [mode, setMode] = useState<"movimientos" | "asiento" | "abonos">("movimientos");

  const [data, setData] = useState<CruceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkTarget, setLinkTarget] = useState<CruceRow | null>(null);
  const [posFicticioTarget, setPosFicticioTarget] = useState<CruceRow | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  async function onDesvincular(row: CruceRow) {
    if (!row.tbkTesoreriaId) return;
    const msg =
      row.settCount > 1
        ? `Deshacer este vínculo manual? Se desvinculan los ${row.settCount} abonos del grupo y todo vuelve a quedar sin conciliar.`
        : "Deshacer este vínculo manual? El par volverá a quedar sin conciliar.";
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/link?tbkTesoreriaId=${row.tbkTesoreriaId}`, {
        method: "DELETE",
      });
      if (res.ok) load();
      else {
        const j = await res.json().catch(() => ({}));
        setBanner({ kind: "err", msg: j.error || "Error al desvincular" });
      }
    } finally {
      setBusy(false);
    }
  }

  // Deriva un abono/cargo ajeno a la empresa (Settlement sin POS que jamás
  // tendrá POS) a la subtab "Abonos conciliados" (asiento directo Debe/Haber).
  async function onAbonoConciliado(row: CruceRow) {
    if (!row.transbankSaleId) return;
    if (
      !confirm(
        "¿Marcar este abono como AJENO a la empresa? Se moverá a la subtab \"Abonos conciliados\" " +
          "para contabilizarlo directo Debe/Haber (reversible con \"Devolver\").",
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/consolidados/cruce-transbank/abonos-conciliados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transbankSaleIds: [row.transbankSaleId] }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setBanner({ kind: "ok", msg: j.mensaje || "Abono movido a Abonos conciliados." });
        load();
      } else {
        setBanner({ kind: "err", msg: j.error || "Error al mover el abono" });
      }
    } finally {
      setBusy(false);
    }
  }

  // Borra un POS ficticio (y su vínculo). El abono vuelve a "sin POS".
  async function onBorrarFicticio(row: CruceRow) {
    if (!row.tbkTesoreriaId) return;
    if (!confirm("Borrar este POS ficticio? El abono volverá a quedar sin POS.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/pos-ficticio?tbkTesoreriaId=${row.tbkTesoreriaId}`, {
        method: "DELETE",
      });
      if (res.ok) load();
      else {
        const j = await res.json().catch(() => ({}));
        setBanner({ kind: "err", msg: j.error || "Error al borrar el POS ficticio" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (sucursalId) p.set("sucursalId", sucursalId);
      if (estado) p.set("estado", estado);
      const res = await fetch(`/api/consolidados/cruce-transbank?${p}`);
      if (res.ok) setData(await res.json());
      else if (!silent) setData(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // Refresco suave desde la BD (el sync POS lo hace el scheduler del server).
    const id = setInterval(() => load(true), 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, sucursalId, estado]);

  async function onSyncPos() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/transbank/sync", { method: "POST" });
      const j = await res.json();
      if (!res.ok) {
        setBanner({ kind: "err", msg: j.error || "Error al sincronizar POS" });
      } else {
        setBanner({
          kind: "ok",
          msg: `POS sincronizado: ${j.insertedRows} nuevos, ${j.updatedRows} actualizados (${j.pages} págs)`,
        });
        load();
      }
    } catch {
      setBanner({ kind: "err", msg: "Error de red al sincronizar" });
    } finally {
      setBusy(false);
    }
  }

  const k = data?.kpis;

  return (
    <div className="space-y-4">
      {/* Toggle Movimientos / Conciliados (asiento) */}
      <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-sm">
        <button
          onClick={() => setMode("movimientos")}
          className={`px-3 py-1.5 font-semibold ${mode === "movimientos" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
        >
          Movimientos
        </button>
        <button
          onClick={() => setMode("asiento")}
          className={`px-3 py-1.5 font-semibold ${mode === "asiento" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
        >
          Conciliados (asiento)
        </button>
        <button
          onClick={() => setMode("abonos")}
          className={`px-3 py-1.5 font-semibold ${mode === "abonos" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
          title="Abonos/cargos de Transbank ajenos a la empresa (sin POS): asiento directo Debe/Haber"
        >
          Abonos conciliados
        </button>
      </div>

      {/* Filtros + resumen (estilo egresos) */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-text-muted">Desde</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="block text-text-muted">Hasta</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input" />
        </label>
        <label className="text-sm">
          <span className="block text-text-muted">Sucursal</span>
          <select value={sucursalId} onChange={(e) => setSucursalId(e.target.value)} className="input">
            <option value="">Todas</option>
            {data?.facets.sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? `#${s.id}`}
              </option>
            ))}
          </select>
        </label>
        {mode === "movimientos" && (
          <label className="text-sm">
            <span className="block text-text-muted">Estado</span>
            <select value={estado} onChange={(e) => setEstado(e.target.value as Estado | "")} className="input">
              <option value="">Todos</option>
              <option value="cuadrado">Cuadrados</option>
              <option value="pos_sin_settlement">Sin settlement</option>
              <option value="settlement_sin_pos">Sin POS (cartola)</option>
            </select>
          </label>
        )}
        {can("importar") && (
          <button onClick={onSyncPos} disabled={busy} className="btn-ghost text-sm">
            {busy ? "Sincronizando…" : "Sincronizar POS"}
          </button>
        )}
        {mode === "movimientos" && (
          <button
            onClick={() => setAuditOpen(true)}
            className="btn-ghost text-sm"
            title="Generar un informe imprimible del detalle de esta vista (para respaldo en papel)"
          >
            Auditoría
          </button>
        )}
        {mode === "movimientos" && k && (
          <div className="ml-auto text-sm text-text-muted text-right leading-tight">
            <div>
              <b className="text-emerald-700">{k.cuadrados}</b> cuadrados ·{" "}
              <b className="text-amber-700">{k.posSinSettlement}</b> sin settlement ·{" "}
              <b className="text-rose-700">{k.settlementSinPos}</b> sin POS
            </div>
            <div className="text-xs">
              Neto cuadrado: ${formatMoney(BigInt(k.totalNeto))}
              {k.conRecargo > 0 &&
                ` · ${k.conRecargo} con recargo Transbank (crédito, +$${formatMoney(BigInt(k.totalRecargo))})`}
            </div>
          </div>
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

      {mode === "abonos" ? (
        <AbonosConciliadosView from={from} to={to} sucursalId={sucursalId} />
      ) : mode === "asiento" ? (
        <CuadraturaTransbankView from={from} to={to} sucursalId={sucursalId} />
      ) : (
        <>
      {/* Tabla */}
      <div className="rounded-xl border border-border-soft overflow-hidden">
        {loading && <div className="p-4 text-sm text-text-muted">Cargando…</div>}
        {!loading && data && data.rows.length === 0 && (
          <div className="p-4 text-sm text-text-muted">
            Sin datos en el rango. Importá el .xls de Transbank y/o sincronizá el POS.
          </div>
        )}
        {!loading && data && data.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Estado</th>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Sucursal</th>
                  <th className="px-3 py-2 text-left">OP / Boleta</th>
                  <th className="px-3 py-2 text-left">Medio</th>
                  <th className="px-3 py-2 text-right">Monto POS</th>
                  <th
                    className="px-3 py-2 text-right"
                    title="Recargo de crédito de Transbank (~2% sobre la boleta): bruto del settlement − monto base del POS. En débito es 0."
                  >
                    Recargo TBK
                  </th>
                  <th className="px-3 py-2 text-right">Comisión</th>
                  <th className="px-3 py-2 text-right">Neto</th>
                  <th className="px-3 py-2 text-left">Glosa / Local</th>
                  <th className="px-3 py-2 text-center">Acción</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ESTADO_META[r.estado].cls}`}
                      >
                        {ESTADO_META[r.estado].label}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.fecha)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.sucursalName ?? (r.sucursalId ? `#${r.sucursalId}` : "—")}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                      {r.settCount > 1 ? r.boleta : r.op ?? r.boleta ?? "—"}
                      {r.settCount > 1 && (
                        <span
                          className="ml-1.5 inline-block rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200 text-[10px] px-1.5 py-0.5 font-bold align-middle"
                          title={`Pago dividido: 1 POS cuadrado contra ${r.settCount} abonos Transbank`}
                        >
                          1↔{r.settCount}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.medioPago ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      ${formatMoney(BigInt(r.montoBruto))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {r.diferencia && r.diferencia !== "0" ? (
                        <span
                          className="text-amber-700"
                          title="Recargo de crédito de Transbank (~2% sobre la boleta): bruto del settlement − monto base del POS. No es un error: es lo que Transbank suma en crédito."
                        >
                          +${formatMoney(BigInt(r.diferencia))}
                          {r.diferenciaPct != null && (
                            <span className="text-xs"> ({r.diferenciaPct}% recargo TBK)</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-text-muted">
                      {r.comision ? `$${formatMoney(BigInt(r.comision))}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {r.neto ? `$${formatMoney(BigInt(r.neto))}` : "—"}
                    </td>
                    <td className="px-3 py-2 max-w-[280px] truncate" title={r.glosa ?? ""}>
                      {r.glosa ?? ""}
                      {r.ficticio && (
                        <span
                          className="ml-1.5 inline-block rounded-full bg-violet-100 text-violet-800 border border-violet-200 text-[10px] px-1.5 py-0.5 font-bold align-middle"
                          title="POS ficticio (insertado a mano, no viene de la API)"
                        >
                          FICTICIO
                        </span>
                      )}
                      {r.manual && !r.ficticio && (
                        <span
                          className="ml-1.5 inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-200 text-[10px] px-1.5 py-0.5 font-bold align-middle"
                          title="Vinculado manualmente"
                        >
                          MANUAL
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {can("conciliar") && r.estado === "pos_sin_settlement" && (
                        <button
                          onClick={() => setLinkTarget(r)}
                          className="text-brand hover:underline text-xs"
                          title="Buscar y vincular su abono Transbank a mano"
                        >
                          Vincular
                        </button>
                      )}
                      {can("conciliar") && r.estado === "settlement_sin_pos" && (
                        <>
                          <button
                            onClick={() => setPosFicticioTarget(r)}
                            className="text-brand hover:underline text-xs"
                            title="Crear un POS ficticio (manual) para cuadrar este abono"
                          >
                            Crear POS
                          </button>
                          <button
                            onClick={() => onAbonoConciliado(r)}
                            disabled={busy}
                            className="ml-2 text-fuchsia-700 hover:underline text-xs disabled:opacity-50"
                            title="Abono/cargo ajeno a la empresa (jamás tendrá POS): moverlo a la subtab Abonos conciliados para contabilizarlo directo Debe/Haber"
                          >
                            Abono conciliado
                          </button>
                        </>
                      )}
                      {can("conciliar") && r.estado === "cuadrado" && r.ficticio && (
                        <button
                          onClick={() => onBorrarFicticio(r)}
                          disabled={busy}
                          className="text-rose-700 hover:underline text-xs disabled:opacity-50"
                          title="Borrar el POS ficticio (el abono vuelve a quedar sin POS)"
                        >
                          Borrar POS
                        </button>
                      )}
                      {can("conciliar") && r.estado === "cuadrado" && r.manual && !r.ficticio && (
                        <button
                          onClick={() => onDesvincular(r)}
                          disabled={busy}
                          className="text-rose-700 hover:underline text-xs disabled:opacity-50"
                        >
                          Desvincular
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {data && data.rowsTotal > data.rows.length && (
        <p className="text-xs text-text-muted">
          Mostrando {data.rows.length} de {data.rowsTotal} filas.
        </p>
      )}
        </>
      )}

      {linkTarget && (
        <VincularModal
          pos={linkTarget}
          from={from}
          to={to}
          onClose={() => setLinkTarget(null)}
          onLinked={() => {
            setLinkTarget(null);
            setBanner({ kind: "ok", msg: "Vínculo creado. El par quedó cuadrado." });
            load();
          }}
        />
      )}

      {auditOpen && (
        <AuditoriaModal
          from={from}
          to={to}
          sucursalId={sucursalId}
          sucursales={data?.facets.sucursales ?? []}
          estadoActual={estado}
          emisor={me?.user?.email ?? ""}
          onClose={() => setAuditOpen(false)}
        />
      )}

      {posFicticioTarget && (
        <PosFicticioModal
          sett={posFicticioTarget}
          sucursales={data?.facets.sucursales ?? []}
          onClose={() => setPosFicticioTarget(null)}
          onCreated={() => {
            setPosFicticioTarget(null);
            setBanner({ kind: "ok", msg: "POS ficticio creado. El abono quedó cuadrado." });
            load();
          }}
        />
      )}
    </div>
  );
}

/* ===================== Modal POS ficticio ===================== */

function PosFicticioModal({
  sett,
  sucursales,
  onClose,
  onCreated,
}: {
  sett: CruceRow;
  // Sucursales del CRUCE (convención POS/settlement: sucursalId 2-10 + nombre
  // limpio). NO el maestro: ese usa otra convención (2xx) y mezcla rubros, lo que
  // creaba sucursales duplicadas.
  sucursales: { id: number; name: string | null }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // Pre-cargado desde el abono (settlement). El monto por defecto es el bruto del
  // abono = parte tarjeta (lo contablemente correcto para que cuadre exacto).
  const [sucursalId, setSucursalId] = useState<string>(sett.sucursalId != null ? String(sett.sucursalId) : "");
  const [fecha, setFecha] = useState<string>(sett.fecha.slice(0, 10));
  const [monto, setMonto] = useState<string>(String(Math.abs(Number(sett.montoBruto))));
  const [opNumber, setOpNumber] = useState<string>(sett.boleta ?? "");
  const [glosa, setGlosa] = useState<string>(
    `POS MANUAL${sett.glosa ? ` - ${sett.glosa}` : ""}`,
  );
  const [nota, setNota] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const montoNum = Math.round(Number(monto) || 0);
  const dif = montoNum - Math.abs(Number(sett.montoBruto));

  async function crear() {
    if (!sucursalId) { setErr("Elegí la sucursal."); return; }
    if (montoNum <= 0) { setErr("El monto debe ser mayor a 0."); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/pos-ficticio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transbankSaleId: sett.transbankSaleId,
          sucursalId: Number(sucursalId),
          fecha,
          monto: montoNum,
          opNumber: opNumber.trim() || null,
          glosa: glosa.trim() || null,
          medioPago: sett.medioPago,
          nota: nota.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j.error || "Error al crear el POS ficticio");
      else onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold tracking-tight">Crear POS ficticio</h2>
          <button onClick={onClose} className="btn-ghost text-sm">Cerrar</button>
        </div>

        <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm mb-3">
          <div className="text-text-muted text-xs uppercase tracking-wide mb-1">Abono Transbank a cuadrar</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span><b>{formatDate(sett.fecha)}</b></span>
            <span>{sett.sucursalName ?? (sett.sucursalId ? `#${sett.sucursalId}` : "—")}</span>
            <span className="font-mono">Boleta {sett.boleta ?? "—"}</span>
            <span>{sett.medioPago ?? "—"}</span>
            <span className="font-mono">Bruto ${formatMoney(BigInt(sett.montoBruto))}</span>
          </div>
        </div>

        <p className="text-xs text-text-muted mb-3">
          Crea un movimiento POS <b>ficticio</b> (no viene de la API) y lo vincula a este abono. Útil cuando
          la venta no la registró la API (ej. pago parte tarjeta + parte efectivo). El monto por defecto es la
          <b> parte tarjeta</b> (= bruto del abono); el efectivo se registra aparte.
        </p>

        {err && <div className="rounded-md bg-rose-50 text-rose-800 border border-rose-200 px-3 py-2 text-sm mb-2">{err}</div>}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted">Sucursal</span>
            <select value={sucursalId} onChange={(e) => setSucursalId(e.target.value)} className="input w-full">
              <option value="">— Elegí —</option>
              {sucursales.map((s) => (
                <option key={s.id} value={s.id}>{s.name ?? `#${s.id}`}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Fecha</span>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="input w-full" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">N° operación / boleta</span>
            <input
              type="text"
              value={opNumber}
              onChange={(e) => setOpNumber(e.target.value)}
              placeholder="N° de operación (editable)"
              className="input w-full font-mono"
            />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted">Monto (bruto)</span>
            <input type="number" step="1" value={monto} onChange={(e) => setMonto(e.target.value)} className="input w-full font-mono" />
          </label>
          <label className="text-sm col-span-2">
            <span className="block text-text-muted">Glosa</span>
            <input type="text" value={glosa} onChange={(e) => setGlosa(e.target.value)} maxLength={500} className="input w-full" />
          </label>
          <label className="text-sm col-span-2">
            <span className="block text-text-muted">Nota (opcional)</span>
            <input type="text" value={nota} onChange={(e) => setNota(e.target.value)} maxLength={500} placeholder="ej: pago $X tarjeta + $Y efectivo" className="input w-full" />
          </label>
        </div>

        {dif !== 0 && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2 text-xs">
            ⚠ El monto difiere del bruto del abono en <b>${formatMoney(BigInt(Math.abs(dif)))}</b>. Esa diferencia
            se registrará como recargo/diferencia (rubro 1403/708) en el asiento. Para cuadre exacto, dejá el monto
            igual al bruto.
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} disabled={busy} className="btn-ghost text-sm">Cancelar</button>
          <button
            onClick={crear}
            disabled={busy}
            className="rounded-md bg-brand text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Creando…" : "Crear y vincular"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Modal de vinculación manual ===================== */

function VincularModal({
  pos,
  from,
  to,
  onClose,
  onLinked,
}: {
  pos: CruceRow;
  from: string;
  to: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [cands, setCands] = useState<CruceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Selección múltiple: un POS puede cuadrar contra 2+ abonos (pago dividido).
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const posMonto = BigInt(pos.montoBruto);
  const selectedRows = (cands ?? []).filter((c) => c.transbankSaleId && selected.has(c.transbankSaleId));
  const selectedSum = selectedRows.reduce((acc, c) => acc + BigInt(c.montoBruto), 0n);
  const deltaSel = selectedSum - posMonto;

  function toggle(sett: CruceRow) {
    if (!sett.transbankSaleId) return;
    const next = new Set(selected);
    if (next.has(sett.transbankSaleId)) next.delete(sett.transbankSaleId);
    else next.add(sett.transbankSaleId);
    setSelected(next);
  }

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams({ from, to, estado: "settlement_sin_pos" });
        const res = await fetch(`/api/consolidados/cruce-transbank?${p}`);
        const j = res.ok ? await res.json() : { rows: [] };
        if (cancel) return;
        // Ranking: misma sucursal primero, luego menor diferencia de monto, luego fecha cercana.
        const posDate = new Date(pos.fecha).getTime();
        const rows: CruceRow[] = (j.rows as CruceRow[]).slice().sort((a, b) => {
          const sa = a.sucursalId === pos.sucursalId ? 0 : 1;
          const sb = b.sucursalId === pos.sucursalId ? 0 : 1;
          if (sa !== sb) return sa - sb;
          const da = Number(absBig(BigInt(a.montoBruto) - posMonto));
          const dbb = Number(absBig(BigInt(b.montoBruto) - posMonto));
          if (da !== dbb) return da - dbb;
          return Math.abs(new Date(a.fecha).getTime() - posDate) - Math.abs(new Date(b.fecha).getTime() - posDate);
        });
        setCands(rows);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [from, to, pos.fecha, pos.sucursalId, posMonto]);

  async function link(settIds: string[]) {
    if (!pos.tbkTesoreriaId || settIds.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tbkTesoreriaId: pos.tbkTesoreriaId, transbankSaleIds: settIds }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setErr(j.error || "Error al vincular");
      else onLinked();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold tracking-tight">Vincular abono Transbank</h2>
          <button onClick={onClose} className="btn-ghost text-sm">Cerrar</button>
        </div>

        <div className="rounded-md border border-border-soft bg-bg-soft p-3 text-sm mb-3">
          <div className="text-text-muted text-xs uppercase tracking-wide mb-1">Movimiento POS a vincular</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span><b>{formatDate(pos.fecha)}</b></span>
            <span>{pos.sucursalName ?? `#${pos.sucursalId}`}</span>
            <span className="font-mono">OP {pos.op ?? "—"}</span>
            <span className="font-mono">${formatMoney(posMonto)}</span>
            <span className="text-text-muted truncate max-w-[320px]" title={pos.glosa ?? ""}>{pos.glosa}</span>
          </div>
        </div>

        {err && <div className="rounded-md bg-rose-50 text-rose-800 border border-rose-200 px-3 py-2 text-sm mb-2">{err}</div>}

        <p className="text-xs text-text-muted mb-2">
          Elegí el o los abonos que corresponden (un giro pagado en 2+ transacciones de tarjeta se vincula a{" "}
          <b>varios abonos a la vez</b>). Ordenados por sucursal, monto más cercano y fecha. El monto <b>no tiene que
          ser exacto</b>: en crédito, Transbank liquida la boleta <b>+ ~2% de recargo</b>. Esa diferencia es el{" "}
          <b>recargo de crédito de Transbank</b> y se registra automáticamente en el asiento (rubro comisión/recargo{" "}
          <b>708</b> y, donde aplica, <b>1403 Diferencia</b>) al generar la cuadratura.
        </p>

        {selected.size > 0 && (
          <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <b>{selected.size}</b> abono{selected.size > 1 ? "s" : ""} seleccionado{selected.size > 1 ? "s" : ""}:{" "}
              <span className="font-mono">${formatMoney(selectedSum)}</span> de{" "}
              <span className="font-mono">${formatMoney(posMonto)}</span> del POS
            </span>
            <span className={deltaSel === 0n ? "text-emerald-700 font-semibold" : "text-amber-700"}>
              {deltaSel === 0n
                ? "Δ $0 — cuadre exacto"
                : `Δ ${deltaSel > 0n ? "+" : "−"}$${formatMoney(absBig(deltaSel))}`}
            </span>
            <button
              onClick={() => link(Array.from(selected))}
              disabled={busy}
              className="ml-auto rounded-md bg-brand text-white px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Vinculando…" : `Vincular ${selected.size > 1 ? `los ${selected.size}` : ""}`}
            </button>
          </div>
        )}

        <div className="rounded-lg border border-border-soft max-h-[50vh] overflow-auto">
          {loading && <div className="p-4 text-sm text-text-muted">Buscando candidatos…</div>}
          {!loading && cands && cands.length === 0 && (
            <div className="p-4 text-sm text-text-muted">No hay abonos sin POS en el rango. Ampliá las fechas.</div>
          )}
          {!loading && cands && cands.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-center w-8"></th>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Sucursal</th>
                  <th className="px-3 py-2 text-left">Boleta</th>
                  <th className="px-3 py-2 text-left">Medio</th>
                  <th className="px-3 py-2 text-right" title="Monto bruto de la venta">Bruto</th>
                  <th className="px-3 py-2 text-right" title="Comisión Transbank (comisión + IVA)">Comisión</th>
                  <th className="px-3 py-2 text-right" title="Bruto − comisión: lo que llega al banco">Bruto − com.</th>
                  <th className="px-3 py-2 text-center sticky right-0 bg-bg-soft">Acción</th>
                </tr>
              </thead>
              <tbody>
                {cands.map((c, i) => {
                  const sameSuc = c.sucursalId === pos.sucursalId;
                  const checked = !!c.transbankSaleId && selected.has(c.transbankSaleId);
                  return (
                    <tr
                      key={i}
                      className={`border-t border-border-soft/60 hover:bg-bg-soft/40 cursor-pointer ${checked ? "bg-indigo-50/60" : ""}`}
                      onClick={() => toggle(c)}
                    >
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(c)}
                          onClick={(e) => e.stopPropagation()}
                          className="accent-brand"
                        />
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(c.fecha)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {c.sucursalName ?? (c.sucursalId ? `#${c.sucursalId}` : "—")}
                        {!sameSuc && <span className="ml-1 text-[10px] text-amber-700">(otra)</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-xs">{c.boleta ?? "—"}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{c.medioPago ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-text-muted">${formatMoney(BigInt(c.montoBruto))}</td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-text-muted">{c.comision ? `$${formatMoney(BigInt(c.comision))}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-emerald-700">${formatMoney(BigInt(c.montoBruto) - BigInt(c.comision ?? "0"))}</td>
                      <td className="px-3 py-1.5 text-center sticky right-0 bg-white">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (c.transbankSaleId) link([c.transbankSaleId]);
                          }}
                          disabled={busy}
                          className="rounded-md bg-brand text-white px-2.5 py-1 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                          title="Vincular solo este abono (1:1)"
                        >
                          Vincular
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===================== Modal Auditoría (informe imprimible) ===================== */

const ESTADO_ORDEN: Estado[] = ["settlement_sin_pos", "pos_sin_settlement", "cuadrado"];
const ESTADO_INFORME: Record<Estado, { titulo: string; desc: string }> = {
  settlement_sin_pos: {
    titulo: "Abonos Transbank sin POS (irregulares)",
    desc: "Ventas liquidadas por Transbank que no tienen operación registrada en el sistema de caja.",
  },
  pos_sin_settlement: {
    titulo: "POS sin settlement",
    desc: "Operaciones de caja con tarjeta que no tienen abono Transbank cargado en el período.",
  },
  cuadrado: {
    titulo: "Cuadrados",
    desc: "Pares POS ↔ abono conciliados (automáticos y manuales).",
  },
};

function AuditoriaModal({
  from,
  to,
  sucursalId,
  sucursales,
  estadoActual,
  emisor,
  onClose,
}: {
  from: string;
  to: string;
  sucursalId: string;
  sucursales: { id: number; name: string | null }[];
  estadoActual: Estado | "";
  emisor: string;
  onClose: () => void;
}) {
  // Preselección: el estado filtrado en la vista; si no hay, los dos irregulares.
  const [estados, setEstados] = useState<Set<Estado>>(
    () => new Set<Estado>(estadoActual ? [estadoActual] : ["settlement_sin_pos", "pos_sin_settlement"]),
  );
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sucursalName =
    sucursalId === ""
      ? "Todas"
      : sucursales.find((s) => String(s.id) === sucursalId)?.name ?? `#${sucursalId}`;

  function toggleEstado(e: Estado) {
    const next = new Set(estados);
    if (next.has(e)) next.delete(e);
    else next.add(e);
    setEstados(next);
  }

  async function imprimir() {
    if (estados.size === 0) {
      setErr("Elegí al menos un estado para el informe.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const p = new URLSearchParams({ from, to });
      if (sucursalId) p.set("sucursalId", sucursalId);
      const res = await fetch(`/api/consolidados/cruce-transbank?${p}`);
      if (!res.ok) {
        setErr("Error al cargar los datos del informe.");
        return;
      }
      const j = (await res.json()) as CruceResponse;
      const win = window.open("", "_blank");
      if (!win) {
        setErr("El navegador bloqueó la ventana del informe. Permití los pop-ups para este sitio.");
        return;
      }
      win.document.write(
        buildInformeHtml({
          rows: j.rows,
          estados,
          from,
          to,
          sucursalName,
          emisor,
          nota: nota.trim(),
          truncado: j.rowsTotal > j.rows.length ? j.rowsTotal : null,
        }),
      );
      win.document.close();
      win.focus();
      // Dar tiempo a que la ventana renderice antes del diálogo de impresión.
      setTimeout(() => win.print(), 350);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold tracking-tight">Informe de auditoría</h2>
          <button onClick={onClose} className="btn-ghost text-sm">Cerrar</button>
        </div>

        <p className="text-xs text-text-muted mb-3">
          Genera un documento imprimible con el detalle de esta vista (rango <b>{from}</b> →{" "}
          <b>{to}</b>, sucursal <b>{sucursalName}</b>), con totales por sección y espacio de firmas
          para respaldo en papel.
        </p>

        {err && (
          <div className="rounded-md bg-rose-50 text-rose-800 border border-rose-200 px-3 py-2 text-sm mb-2">
            {err}
          </div>
        )}

        <div className="space-y-2 mb-3">
          <span className="block text-sm text-text-muted">Incluir en el informe</span>
          {ESTADO_ORDEN.map((e) => (
            <label
              key={e}
              className="flex items-start gap-2 rounded-md border border-border-soft px-3 py-2 cursor-pointer hover:bg-bg-soft/50"
            >
              <input
                type="checkbox"
                checked={estados.has(e)}
                onChange={() => toggleEstado(e)}
                className="accent-brand mt-0.5"
              />
              <span className="text-sm">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold mr-1.5 ${ESTADO_META[e].cls}`}
                >
                  {ESTADO_META[e].label}
                </span>
                <span className="block text-xs text-text-muted mt-0.5">{ESTADO_INFORME[e].desc}</span>
              </span>
            </label>
          ))}
        </div>

        <label className="text-sm block mb-4">
          <span className="block text-text-muted">Nota / motivo (se imprime en el encabezado, opcional)</span>
          <textarea
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="ej: transacciones irregulares detectadas en SUECIA, semana del 07-07"
            className="input w-full"
          />
        </label>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn-ghost text-sm">Cancelar</button>
          <button
            onClick={imprimir}
            disabled={busy}
            className="rounded-md bg-brand text-white px-4 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Generando…" : "Generar e imprimir"}
          </button>
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildInformeHtml(opts: {
  rows: CruceRow[];
  estados: Set<Estado>;
  from: string;
  to: string;
  sucursalName: string;
  emisor: string;
  nota: string;
  truncado: number | null;
}): string {
  const { rows, estados, from, to, sucursalName, emisor, nota, truncado } = opts;
  const emitido = new Date().toLocaleString("es-CL");
  const fmt = (s: string | null) => (s == null ? "—" : `$${formatMoney(BigInt(s))}`);

  const secciones = ESTADO_ORDEN.filter((e) => estados.has(e))
    .map((e) => {
      const list = rows.filter((r) => r.estado === e);
      const totalBruto = list.reduce((acc, r) => acc + BigInt(r.montoBruto), 0n);
      const totalNeto = list.reduce((acc, r) => acc + BigInt(r.neto ?? "0"), 0n);
      const filas = list
        .map(
          (r) => `<tr>
            <td>${formatDate(r.fecha)}</td>
            <td>${escapeHtml(r.sucursalName ?? (r.sucursalId != null ? `#${r.sucursalId}` : "—"))}</td>
            <td class="mono">${escapeHtml(r.settCount > 1 ? r.boleta ?? "—" : r.op ?? r.boleta ?? "—")}${r.settCount > 1 ? " (1↔" + r.settCount + ")" : ""}</td>
            <td>${escapeHtml(r.medioPago ?? "—")}</td>
            <td class="mono num">${fmt(r.montoBruto)}</td>
            <td class="mono num">${r.comision ? fmt(r.comision) : "—"}</td>
            <td class="mono num">${r.neto ? fmt(r.neto) : "—"}</td>
            <td class="glosa">${escapeHtml(r.glosa ?? "")}${r.ficticio ? " <b>[POS FICTICIO]</b>" : r.manual ? " <b>[MANUAL]</b>" : ""}</td>
          </tr>`,
        )
        .join("");
      return `
        <section>
          <h2>${ESTADO_INFORME[e].titulo} <span class="count">(${list.length})</span></h2>
          <p class="desc">${ESTADO_INFORME[e].desc}</p>
          ${
            list.length === 0
              ? `<p class="desc"><i>Sin movimientos en el rango.</i></p>`
              : `<table>
            <thead><tr>
              <th>Fecha</th><th>Sucursal</th><th>OP / Boleta</th><th>Medio</th>
              <th class="num">Monto bruto</th><th class="num">Comisión</th><th class="num">Neto</th><th>Glosa / Local</th>
            </tr></thead>
            <tbody>${filas}</tbody>
            <tfoot><tr>
              <td colspan="4"><b>Total (${list.length} movimientos)</b></td>
              <td class="mono num"><b>$${formatMoney(totalBruto)}</b></td>
              <td></td>
              <td class="mono num"><b>${totalNeto !== 0n ? `$${formatMoney(totalNeto)}` : "—"}</b></td>
              <td></td>
            </tr></tfoot>
          </table>`
          }
        </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Auditoría Cruce Transbank ${from} a ${to}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 11px/1.4 "Segoe UI", Arial, sans-serif; color: #111; margin: 24px; }
  header { border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #444; font-size: 11px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 8px; font-size: 11px; }
  .meta b { display: inline-block; min-width: 0; }
  .nota { margin-top: 8px; padding: 6px 8px; border: 1px solid #999; background: #f5f5f5; font-size: 11px; }
  h2 { font-size: 13px; margin: 18px 0 2px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  .count { color: #555; font-weight: normal; }
  .desc { color: #555; margin: 2px 0 6px; font-size: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 10px; }
  th { text-align: left; border-bottom: 1px solid #111; padding: 3px 6px; font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
  td { border-bottom: 1px solid #ddd; padding: 3px 6px; vertical-align: top; }
  tfoot td { border-top: 1.5px solid #111; border-bottom: none; padding-top: 5px; }
  .num { text-align: right; }
  .mono { font-family: Consolas, "Courier New", monospace; font-variant-numeric: tabular-nums; }
  .glosa { max-width: 220px; word-break: break-word; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  section { page-break-inside: auto; }
  .firmas { display: flex; gap: 60px; margin-top: 48px; page-break-inside: avoid; }
  .firma { flex: 1; text-align: center; font-size: 10px; color: #333; }
  .firma .linea { border-top: 1px solid #111; margin-bottom: 4px; padding-top: 4px; }
  footer { margin-top: 24px; font-size: 9px; color: #666; }
  @media print { body { margin: 10mm; } }
</style>
</head>
<body>
  <header>
    <h1>MORE · Conciliación — Informe de auditoría · Cruce Transbank</h1>
    <div class="sub">Detalle de movimientos POS ↔ abonos Transbank para respaldo documental.</div>
    <div class="meta">
      <span>Período: <b>${from} → ${to}</b></span>
      <span>Sucursal: <b>${escapeHtml(sucursalName)}</b></span>
      <span>Emitido: <b>${emitido}</b></span>
      ${emisor ? `<span>Emitido por: <b>${escapeHtml(emisor)}</b></span>` : ""}
    </div>
    ${nota ? `<div class="nota"><b>Nota:</b> ${escapeHtml(nota)}</div>` : ""}
    ${truncado ? `<div class="nota">⚠ El rango tiene ${truncado} movimientos; este informe muestra los primeros ${rows.length}. Acotá las fechas para el detalle completo.</div>` : ""}
  </header>
  ${secciones}
  <div class="firmas">
    <div class="firma"><div class="linea">Preparado por</div>Nombre, firma y fecha</div>
    <div class="firma"><div class="linea">Revisado por</div>Nombre, firma y fecha</div>
    <div class="firma"><div class="linea">Gerencia</div>Nombre, firma y fecha</div>
  </div>
  <footer>
    Generado por el sistema de Conciliación. "Abonos sin POS" = liquidado por Transbank sin operación de caja registrada;
    "POS sin settlement" = operación de caja sin abono cargado en el período. Los marcados [MANUAL] fueron vinculados a mano;
    [POS FICTICIO] son operaciones insertadas manualmente para documentar ventas no registradas por la caja.
  </footer>
</body>
</html>`;
}

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstDayOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
