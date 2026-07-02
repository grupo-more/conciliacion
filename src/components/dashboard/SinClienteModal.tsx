"use client";

import { useEffect, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";

interface SinClienteMov {
  id: string;
  fecha: string;
  sucursalId: number;
  sucursalName: string | null;
  cajeroUsername: string;
  cajeroName: string | null;
  monto: string;
  glosa: string;
  tipoOperacion: string;
}

interface Resp {
  total: number;
  montoTotal: string;
  truncated: boolean;
  movements: SinClienteMov[];
}

/**
 * Drill-down de auditoría: lista de movimientos de Tesorería sin cliente,
 * filtrable por sucursal y/o cajero (los pasa quien abre el modal).
 */
export function SinClienteModal({
  from,
  to,
  sucursalId,
  cajero,
  titulo,
  onClose,
}: {
  from: string;
  to: string;
  sucursalId?: number;
  cajero?: string;
  titulo: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams({ from, to });
        if (sucursalId != null) p.set("sucursalId", String(sucursalId));
        if (cajero) p.set("cajero", cajero);
        const res = await fetch(`/api/dashboard/sin-cliente?${p}`);
        setData(res.ok ? await res.json() : null);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, sucursalId, cajero]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Movimientos sin cliente</h2>
            <p className="text-xs text-text-muted">{titulo}</p>
          </div>
          <button onClick={onClose} className="btn-ghost text-sm">
            Cerrar
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-text-muted py-6 text-center">Cargando…</p>
        ) : !data || data.total === 0 ? (
          <p className="text-sm text-text-muted py-6 text-center">
            🎉 No hay movimientos sin cliente en este filtro.
          </p>
        ) : (
          <>
            <div className="text-sm mb-2">
              <span className="font-semibold">{data.total}</span> movimiento(s) sin cliente ·{" "}
              <span className="font-mono">{formatMoney(BigInt(data.montoTotal))}</span>
              {data.truncated && (
                <span className="text-text-muted"> · mostrando los primeros {data.movements.length}</span>
              )}
            </div>
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Fecha</th>
                    <th className="px-2 py-1.5 text-left">Sucursal</th>
                    <th className="px-2 py-1.5 text-left">Cajero</th>
                    <th className="px-2 py-1.5 text-left">Tipo</th>
                    <th className="px-2 py-1.5 text-right">Monto</th>
                    <th className="px-2 py-1.5 text-left">Glosa</th>
                  </tr>
                </thead>
                <tbody>
                  {data.movements.map((m) => (
                    <tr key={m.id} className="border-t border-border-soft/60">
                      <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(m.fecha)}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {m.sucursalName ?? `#${m.sucursalId}`}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {m.cajeroName ?? m.cajeroUsername}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap text-text-muted">{m.tipoOperacion}</td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {formatMoney(BigInt(m.monto))}
                      </td>
                      <td className="px-2 py-1.5 max-w-[360px] truncate" title={m.glosa}>
                        {m.glosa}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
