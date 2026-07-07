"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import { usePermisos } from "@/lib/use-permisos";

interface EgRow {
  id: string;
  fecha: string;
  monto: string;
  glosa: string;
  sucursalId: number;
  sucursalName: string | null;
  cajeroName: string | null;
  rubroId: number | null;
  rubroNombre: string | null;
}
interface Resp {
  total: number;
  sumMonto: string;
  movements: EgRow[];
  facets: {
    sucursales: { id: number; name: string | null }[];
    rubros: { id: number; nombre: string | null; count: number }[];
  };
}

/** Sub-tab "Egresos": gastos operativos (feed /api/egresos). */
export function EgresoMovView() {
  const { can } = usePermisos();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sucursalId, setSucursalId] = useState("");
  const [rubroId, setRubroId] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const PAGE_SIZE = 500;

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (from) p.set("since", from);
      if (to) p.set("until", to);
      if (sucursalId) p.set("sucursalId", sucursalId);
      if (rubroId) p.set("rubroId", rubroId);
      if (q) p.set("q", q);
      const res = await fetch(`/api/egresos/movements?${p}`);
      if (res.ok) setData(await res.json());
      else if (!silent) setData(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => { setPage(0); }, [from, to, sucursalId, rubroId, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    // Refresco suave desde la BD (el sync lo hace el scheduler del server).
    const id = setInterval(() => load(true), 20_000);
    return () => { clearTimeout(t); clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, sucursalId, rubroId, q, page]);

  async function onSync() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/egresos/sync", { method: "POST" });
      const j = await res.json();
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al sincronizar" });
      else {
        setBanner({ kind: "ok", msg: `Sincronizado: ${j.insertedRows} nuevos, ${j.updatedRows} actualizados` });
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar"><input className="input" placeholder="Glosa, rubro, cajero…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Sucursal">
          <select className="input" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
            <option value="">Todas</option>
            {data?.facets.sucursales.map((s) => <option key={s.id} value={s.id}>{s.name ?? `#${s.id}`}</option>)}
          </select>
        </Field>
        <Field label="Rubro">
          <select className="input" value={rubroId} onChange={(e) => setRubroId(e.target.value)}>
            <option value="">Todos</option>
            {data?.facets.rubros.map((r) => <option key={r.id} value={r.id}>{r.nombre ?? `#${r.id}`} ({r.count})</option>)}
          </select>
        </Field>
        <Field label="Desde"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {can("importar") && (
          <button onClick={onSync} disabled={busy} className="btn-ghost">{busy ? "Sincronizando…" : "Sincronizar egresos"}</button>
        )}
      </div>

      {banner && (
        <div className={`rounded-md p-2 text-sm border ${banner.kind === "ok" ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`}>
          {banner.msg}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Egresos" value={data?.total?.toLocaleString("es-CL") ?? "—"} />
        <Stat label="Suma" value={data ? `$${formatMoney(BigInt(data.sumMonto))}` : "—"} />
        <Stat label="En vista" value={data?.movements.length?.toLocaleString("es-CL") ?? "—"} />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Sucursal</th>
              <th className="px-3 py-2 text-left">Rubro</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-3 py-2 text-left">Cajero</th>
              <th className="px-3 py-2 text-left">Glosa</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">Cargando…</td></tr>}
            {!loading && data && data.movements.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">Sin egresos. Sincronizá el feed.</td></tr>
            )}
            {!loading && data?.movements.map((m) => (
              <tr key={m.id} className="border-t border-border-soft/40 hover:bg-bg-elevated/40">
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(m.fecha)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{m.sucursalName ?? `#${m.sucursalId}`}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs">
                  {m.rubroNombre ?? "—"}
                  {m.rubroId != null && <span className="ml-1 text-text-dim font-mono">#{m.rubroId}</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-danger whitespace-nowrap">{formatMoney(BigInt(m.monto))}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs">{m.cajeroName ?? "—"}</td>
                <td className="px-3 py-2 max-w-md truncate" title={m.glosa}>{m.glosa}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-muted">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data.total)} de {data.total.toLocaleString("es-CL")}
          </span>
          <div className="flex gap-2">
            <button className="btn-ghost text-xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ← Anterior
            </button>
            <button
              className="btn-ghost text-xs"
              disabled={(page + 1) * PAGE_SIZE >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-sm"><span className="block text-text-muted">{label}</span>{children}</label>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-soft bg-bg-elevated px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
