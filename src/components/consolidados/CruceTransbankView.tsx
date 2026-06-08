"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";

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
  tid: string | null;
  boleta: string | null;
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

  const [data, setData] = useState<CruceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (sucursalId) p.set("sucursalId", sucursalId);
      if (estado) p.set("estado", estado);
      const res = await fetch(`/api/consolidados/cruce-transbank?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, sucursalId, estado]);

  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setBanner(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/transbank/import", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) {
        setBanner({ kind: "err", msg: j.error || "Error al importar el archivo" });
      } else {
        setBanner({
          kind: "ok",
          msg: `Importado: ${j.inserted?.rowsInserted ?? 0} nuevos, ${j.totals?.duplicates ?? 0} duplicados${j.alreadyImported ? " (archivo ya importado)" : ""}`,
        });
        load();
      }
    } catch {
      setBanner({ kind: "err", msg: "Error de red al importar" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

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
      {/* Acciones */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".xls,.xlsx"
          onChange={onImportFile}
          className="hidden"
          id="tbk-file"
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="btn-primary"
        >
          Importar abonos Transbank (.xls)
        </button>
        <button onClick={onSyncPos} disabled={busy} className="btn-ghost">
          {busy ? "Procesando…" : "Sincronizar POS"}
        </button>
        <span className="text-xs text-text-muted">
          Cruza el POS (tbk-tesoreria) contra el settlement de Transbank por N° de boleta + monto.
        </span>
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

      {/* Filtros */}
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
        <label className="text-sm">
          <span className="block text-text-muted">Estado</span>
          <select value={estado} onChange={(e) => setEstado(e.target.value as Estado | "")} className="input">
            <option value="">Todos</option>
            <option value="cuadrado">Cuadrado</option>
            <option value="pos_sin_settlement">POS sin settlement</option>
            <option value="settlement_sin_pos">Settlement sin POS</option>
          </select>
        </label>
      </div>

      {/* KPIs */}
      {k && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Kpi label="Cuadrados" value={String(k.cuadrados)} tone="ok" />
          <Kpi label="POS sin settlement" value={String(k.posSinSettlement)} tone="warn" />
          <Kpi label="Settlement sin POS" value={String(k.settlementSinPos)} tone="bad" />
          <Kpi label="Total bruto" value={`$${formatMoney(BigInt(k.totalBruto))}`} />
          <Kpi label="Comisión TBK" value={`$${formatMoney(BigInt(k.totalComision))}`} />
          <Kpi label="Neto abonado" value={`$${formatMoney(BigInt(k.totalNeto))}`} />
        </div>
      )}

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
                  <th className="px-3 py-2 text-right">Bruto</th>
                  <th className="px-3 py-2 text-right">Comisión</th>
                  <th className="px-3 py-2 text-right">Neto</th>
                  <th className="px-3 py-2 text-left">Glosa / Local</th>
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
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-text-muted">
                      {r.comision ? `$${formatMoney(BigInt(r.comision))}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {r.neto ? `$${formatMoney(BigInt(r.neto))}` : "—"}
                    </td>
                    <td className="px-3 py-2 max-w-[280px] truncate" title={r.glosa ?? ""}>
                      {r.glosa ?? ""}
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
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const toneCls =
    tone === "ok" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : tone === "bad" ? "text-rose-700" : "text-text";
  return (
    <div className="rounded-lg border border-border-soft bg-bg-elevated px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-lg font-semibold ${toneCls}`}>{value}</div>
    </div>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstDayOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
