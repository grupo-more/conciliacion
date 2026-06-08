"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";

interface Sale {
  id: string;
  fechaVenta: string;
  nombreLocal: string;
  sucursalId: number | null;
  medioPago: string;
  montoVenta: string;
  comision: string;
  totalAbono: string;
  numeroBoleta: string | null;
  tid: string | null;
}
interface Resp {
  total: number;
  sums: { bruto: string; comision: string; neto: string };
  sales: Sale[];
  facets: { sucursales: { id: number; name: string | null }[] };
}

/**
 * Vista de los abonos Transbank importados (settlement "Abonos por día").
 * Read-only; se sube desde el botón "Subir abonos Transbank". El cruce contra
 * el POS vive en Consolidados → Cruce Transbank.
 */
export function TransbankSalesView() {
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [sucursalId, setSucursalId] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (since) p.set("since", since);
      if (until) p.set("until", until);
      if (sucursalId) p.set("sucursalId", sucursalId);
      if (q) p.set("q", q);
      const res = await fetch(`/api/transbank/sales?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since, until, sucursalId, q]);

  return (
    <div className="space-y-3 min-w-0">
      <div className="card flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="label">Buscar</label>
          <input className="input" placeholder="Local, boleta, TID…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label className="label">Sucursal</label>
          <select className="input" value={sucursalId} onChange={(e) => setSucursalId(e.target.value)}>
            <option value="">Todas</option>
            {data?.facets.sucursales.map((s) => <option key={s.id} value={s.id}>{s.name ?? `#${s.id}`}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Desde</label>
          <input type="date" className="input" value={since} onChange={(e) => setSince(e.target.value)} />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input type="date" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
        {data && (
          <div className="ml-auto text-sm text-text-muted text-right leading-tight">
            <div><b>{data.total.toLocaleString("es-CL")}</b> abonos · neto ${formatMoney(BigInt(data.sums.neto))}</div>
            <div className="text-xs">Bruto ${formatMoney(BigInt(data.sums.bruto))} · comisión ${formatMoney(BigInt(data.sums.comision))}</div>
          </div>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Local / Sucursal</th>
              <th className="px-3 py-2 text-left">Medio</th>
              <th className="px-3 py-2 text-left">Boleta</th>
              <th className="px-3 py-2 text-right">Bruto</th>
              <th className="px-3 py-2 text-right">Comisión</th>
              <th className="px-3 py-2 text-right">Neto abono</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted">Cargando…</td></tr>}
            {!loading && data && data.sales.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-text-muted">
                Sin abonos Transbank. Subí el .xls con el botón “Subir abonos Transbank”.
              </td></tr>
            )}
            {!loading && data?.sales.map((s) => (
              <tr key={s.id} className="border-t border-border-soft/40 hover:bg-bg-elevated/40">
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(s.fechaVenta)}</td>
                <td className="px-3 py-2 max-w-[260px] truncate" title={s.nombreLocal}>{s.nombreLocal}</td>
                <td className="px-3 py-2 whitespace-nowrap">{s.medioPago}</td>
                <td className="px-3 py-2 font-mono text-xs">{s.numeroBoleta ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap">${formatMoney(BigInt(s.montoVenta))}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-text-muted">${formatMoney(BigInt(s.comision))}</td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-success">${formatMoney(BigInt(s.totalAbono))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.total > data.sales.length && (
        <p className="text-xs text-text-muted">Mostrando {data.sales.length} de {data.total}.</p>
      )}
    </div>
  );
}
