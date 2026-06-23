"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import { CuadraturaTransbankView } from "./CuadraturaTransbankView";

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
  manual: boolean;
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
  const [from, setFrom] = useState<string>(firstDayOfMonthIso());
  const [to, setTo] = useState<string>(todayIso());
  const [sucursalId, setSucursalId] = useState<string>("");
  const [estado, setEstado] = useState<Estado | "">("");
  const [mode, setMode] = useState<"movimientos" | "asiento">("movimientos");

  const [data, setData] = useState<CruceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkTarget, setLinkTarget] = useState<CruceRow | null>(null);

  async function onDesvincular(row: CruceRow) {
    if (!row.tbkTesoreriaId) return;
    if (!confirm("Deshacer este vínculo manual? El par volverá a quedar sin conciliar.")) return;
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
        <button onClick={onSyncPos} disabled={busy} className="btn-ghost text-sm">
          {busy ? "Sincronizando…" : "Sincronizar POS"}
        </button>
        {mode === "movimientos" && k && (
          <div className="ml-auto text-sm text-text-muted text-right leading-tight">
            <div>
              <b className="text-emerald-700">{k.cuadrados}</b> cuadrados ·{" "}
              <b className="text-amber-700">{k.posSinSettlement}</b> sin settlement ·{" "}
              <b className="text-rose-700">{k.settlementSinPos}</b> sin POS
            </div>
            <div className="text-xs">
              Neto cuadrado: ${formatMoney(BigInt(k.totalNeto))}
              {k.conRecargo > 0 && ` · ${k.conRecargo} c/recargo (+$${formatMoney(BigInt(k.totalRecargo))})`}
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

      {mode === "asiento" ? (
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
                  <th className="px-3 py-2 text-right">Dif (recargo)</th>
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
                      {r.op ?? r.boleta ?? "—"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.medioPago ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      ${formatMoney(BigInt(r.montoBruto))}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {r.diferencia && r.diferencia !== "0" ? (
                        <span className="text-amber-700" title="Recargo de crédito (settlement − base POS)">
                          +${formatMoney(BigInt(r.diferencia))}
                          {r.diferenciaPct != null && <span className="text-xs"> ({r.diferenciaPct}%)</span>}
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
                      {r.manual && (
                        <span
                          className="ml-1.5 inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-200 text-[10px] px-1.5 py-0.5 font-bold align-middle"
                          title="Vinculado manualmente"
                        >
                          MANUAL
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {r.estado === "pos_sin_settlement" && (
                        <button
                          onClick={() => setLinkTarget(r)}
                          className="text-brand hover:underline text-xs"
                          title="Buscar y vincular su abono Transbank a mano"
                        >
                          Vincular
                        </button>
                      )}
                      {r.estado === "cuadrado" && r.manual && (
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

  const posMonto = BigInt(pos.montoBruto);

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

  async function link(sett: CruceRow) {
    if (!pos.tbkTesoreriaId || !sett.transbankSaleId) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/consolidados/cruce-transbank/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tbkTesoreriaId: pos.tbkTesoreriaId, transbankSaleId: sett.transbankSaleId }),
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
          Elegí el abono que corresponde. Ordenados por sucursal, monto más cercano y fecha. El monto <b>no tiene que
          ser exacto</b>: si Transbank liquidó distinto a la boleta, esa diferencia se registra
          automáticamente en el <b>rubro 1403 (Diferencia)</b> al generar el asiento.
        </p>

        <div className="rounded-lg border border-border-soft max-h-[50vh] overflow-auto">
          {loading && <div className="p-4 text-sm text-text-muted">Buscando candidatos…</div>}
          {!loading && cands && cands.length === 0 && (
            <div className="p-4 text-sm text-text-muted">No hay abonos sin POS en el rango. Ampliá las fechas.</div>
          )}
          {!loading && cands && cands.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted sticky top-0">
                <tr>
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
                  return (
                    <tr key={i} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
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
                          onClick={() => link(c)}
                          disabled={busy}
                          className="rounded-md bg-brand text-white px-2.5 py-1 text-xs font-semibold hover:opacity-90 disabled:opacity-50"
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
