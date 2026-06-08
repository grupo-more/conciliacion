"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";

interface TbkRow {
  id: string;
  fecha: string;
  monto: string;
  glosa: string;
  opNumber: string | null;
  sucursalId: number;
  sucursalName: string | null;
  cajeroName: string | null;
  clienteName: string | null;
  clienteRut: string | null;
}
interface Resp {
  total: number;
  sumMonto: string;
  movements: TbkRow[];
  facets: { sucursales: { id: number; name: string | null }[] };
}

/** Sub-tab "17": ventas POS Transbank (feed /api/tbk-tesoreria). */
export function TbkMovView() {
  const [from, setFrom] = useState(firstDayOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [sucursalId, setSucursalId] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ since: from, until: to });
      if (sucursalId) p.set("sucursalId", sucursalId);
      if (q) p.set("q", q);
      const res = await fetch(`/api/transbank/movements?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, sucursalId, q]);

  async function onSync() {
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch("/api/transbank/sync", { method: "POST" });
      const j = await res.json();
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al sincronizar" });
      else {
        setBanner({ kind: "ok", msg: `Sincronizado: ${j.insertedRows} nuevos, ${j.updatedRows} actualizados (${j.pages} págs)` });
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Buscar"><input className="input" placeholder="Glosa, OP, cajero…" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Sucursal">
          <select className="input" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
            <option value="">Todas</option>
            {data?.facets.sucursales.map((s) => <option key={s.id} value={s.id}>{s.name ?? `#${s.id}`}</option>)}
          </select>
        </Field>
        <Field label="Desde"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Hasta"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <button onClick={onSync} disabled={busy} className="btn-ghost">{busy ? "Sincronizando…" : "Sincronizar POS"}</button>
      </div>

      {banner && (
        <div className={`rounded-md p-2 text-sm border ${banner.kind === "ok" ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger"}`}>
          {banner.msg}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Movimientos" value={data?.total?.toLocaleString("es-CL") ?? "—"} />
        <Stat label="Suma (bruto)" value={data ? `$${formatMoney(BigInt(data.sumMonto))}` : "—"} />
        <Stat label="En vista" value={data?.movements.length?.toLocaleString("es-CL") ?? "—"} />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Sucursal</th>
              <th className="px-3 py-2 text-left">OP</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-3 py-2 text-left">Cajero</th>
              <th className="px-3 py-2 text-left">Glosa</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">Cargando…</td></tr>}
            {!loading && data && data.movements.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">Sin movimientos. Sincronizá el POS.</td></tr>
            )}
            {!loading && data?.movements.map((m) => (
              <tr key={m.id} className="border-t border-border-soft/40 hover:bg-bg-elevated/40">
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(m.fecha)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{m.sucursalName ?? `#${m.sucursalId}`}</td>
                <td className="px-3 py-2 font-mono text-xs">{m.opNumber ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono text-success whitespace-nowrap">+{formatMoney(BigInt(m.monto))}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs">{m.cajeroName ?? "—"}</td>
                <td className="px-3 py-2 max-w-md truncate" title={m.glosa}>{m.glosa}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.movements.length && (
        <p className="text-xs text-text-muted">Mostrando {data.movements.length} de {data.total}. Refiná los filtros.</p>
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
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function firstDayOfMonthIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; }
