"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatMoney } from "@/lib/format";
import { prorratear, calcRetencion } from "@/lib/asientos/prorrateo";

interface Sucursal {
  id: string;
  codigo: number | null;
  nombre: string;
  headcount: number;
  active: boolean;
}

interface DetailResp {
  bankMovement: {
    id: string;
    postDate: string;
    amount: string;
    direction: string;
    description: string | null;
    counterpartyName: string | null;
    counterpartyRut: string | null;
    account: { bankName: string; holderName: string; displayNumber: string | null; accountNumber: string };
  };
  asiento: {
    id: string;
    tipo: string;
    estado: string;
    montoNeto: string;
    retencionTasa: number | null;
    montoRetencion: string;
    retencionRubro: number | null;
    montoBruto: string;
    glosa: string | null;
    lineas: Array<{ sucursalNombre: string; personas: number; porcentaje: number; monto: string }>;
  } | null;
}

type Tipo = "PROVEEDOR" | "CLIENTE" | null;

/** Modal para generar (a mano) el asiento de un movimiento de cartola sin
 *  contraparte en el sistema. Proveedor → prorrateo por sucursal; cliente →
 *  por ahora se deja pendiente. */
export function AsientoManualModal({
  bankMovementId,
  onClose,
  onChanged,
}: {
  bankMovementId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<DetailResp | null>(null);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [settings, setSettings] = useState<{ retencionTasa: number; retencionRubro: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [mounted, setMounted] = useState(false);

  const [tipo, setTipo] = useState<Tipo>(null);
  // Sucursales seleccionadas → personas (editable). Se inicializa con todas las
  // activas y su headcount al elegir "proveedor".
  const [sel, setSel] = useState<Map<string, number>>(new Map());
  const [useRet, setUseRet] = useState(false);
  const [retMode, setRetMode] = useState<"tasa" | "monto">("tasa");
  const [retTasa, setRetTasa] = useState(0);
  const [retMonto, setRetMonto] = useState(0);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [d, s, st] = await Promise.all([
          fetch(`/api/consolidados/asientos-manuales/${bankMovementId}`).then((r) => r.json()),
          fetch("/api/sucursales").then((r) => r.json()),
          fetch("/api/asientos-settings").then((r) => r.json()),
        ]);
        setData(d);
        setSucursales((s.sucursales ?? []).filter((x: Sucursal) => x.active));
        setSettings(st);
        setRetTasa(st?.retencionTasa ?? 0);
      } finally {
        setLoading(false);
      }
    })();
  }, [bankMovementId]);

  function startProveedor() {
    setTipo("PROVEEDOR");
    // Selecciona todas las activas con su headcount por defecto.
    setSel(new Map(sucursales.map((s) => [s.id, s.headcount])));
  }

  const montoNeto = useMemo(
    () => (data ? bigAbs(BigInt(data.bankMovement.amount)) : 0n),
    [data],
  );

  const montoRetencion = useMemo(() => {
    if (!useRet) return 0n;
    if (retMode === "monto") return BigInt(Math.max(0, Math.round(retMonto)));
    return calcRetencion(montoNeto, retTasa).montoRetencion;
  }, [useRet, retMode, retMonto, retTasa, montoNeto]);

  const montoBruto = montoNeto + montoRetencion;

  const lineas = useMemo(() => {
    const elegidas = sucursales
      .filter((s) => sel.has(s.id))
      .map((s) => ({ id: s.id, nombre: s.nombre, personas: sel.get(s.id) ?? 0 }));
    if (elegidas.length === 0) return [];
    return prorratear(montoBruto, elegidas);
  }, [sucursales, sel, montoBruto]);

  const totalLineas = useMemo(() => lineas.reduce((a, l) => a + l.monto, 0n), [lineas]);
  const totalPersonas = useMemo(
    () => [...sel.values()].reduce((a, p) => a + p, 0),
    [sel],
  );

  async function generar() {
    if (lineas.length === 0) {
      alert("Elegí al menos una sucursal.");
      return;
    }
    setActing(true);
    try {
      const body = {
        bankMovementId,
        tipo: "PROVEEDOR" as const,
        retencion: useRet
          ? retMode === "monto"
            ? { monto: Math.max(0, Math.round(retMonto)) }
            : { tasa: retTasa }
          : null,
        sucursales: sucursales
          .filter((s) => sel.has(s.id))
          .map((s) => ({ sucursalId: s.id, personas: sel.get(s.id) ?? 0 })),
      };
      const res = await fetch("/api/consolidados/asientos-manuales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => null);
      if (res.ok) {
        onChanged();
        onClose();
      } else alert(j?.error ?? "No se pudo generar el asiento");
    } finally {
      setActing(false);
    }
  }

  async function deshacer() {
    setActing(true);
    try {
      const res = await fetch(`/api/consolidados/asientos-manuales/${bankMovementId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onChanged();
        onClose();
      }
    } finally {
      setActing(false);
    }
  }

  if (!mounted) return null;

  const bm = data?.bankMovement;
  const yaGenerado = data?.asiento?.estado === "GENERADO";

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Asiento manual</h2>
          <button onClick={onClose} className="btn-ghost text-sm">✕</button>
        </div>

        {loading && !data && <p className="text-sm text-text-muted">Cargando…</p>}

        {bm && (
          <>
            {/* Movimiento de banco (HABER) */}
            <div className="rounded-md border border-border-soft bg-bg-soft/40 p-3 text-sm mb-4">
              <div className="flex justify-between">
                <div>
                  <div className="font-semibold">
                    {bm.account.bankName} {bm.account.holderName}
                    <span className="text-xs text-text-muted font-normal"> · {formatDate(bm.postDate)} · {bm.direction}</span>
                  </div>
                  <div className="text-xs text-text-muted">{bm.description}</div>
                  {bm.counterpartyName && (
                    <div className="text-xs mt-0.5">
                      <span className="font-semibold">Contraparte:</span> {bm.counterpartyName}
                      {bm.counterpartyRut && ` (${bm.counterpartyRut})`}
                    </div>
                  )}
                </div>
                <div className="font-mono font-bold">{formatMoney(BigInt(bm.amount))}</div>
              </div>
            </div>

            {/* Ya generado: read-only + deshacer */}
            {yaGenerado && data?.asiento && (
              <GeneradoView asiento={data.asiento} onDeshacer={deshacer} acting={acting} />
            )}

            {/* Clasificación */}
            {!yaGenerado && tipo === null && (
              <div>
                <p className="text-sm text-text-muted mb-3">
                  Este movimiento no tiene contraparte en el sistema. Definí qué es para generar el asiento:
                </p>
                <div className="flex gap-2">
                  <button onClick={startProveedor} className="rounded-md bg-brand text-white text-sm font-semibold px-4 py-2 hover:opacity-90">
                    Pago a proveedor
                  </button>
                  <button onClick={() => setTipo("CLIENTE")} className="rounded-md border border-border-soft text-sm font-semibold px-4 py-2 hover:bg-bg-soft">
                    Pago a cliente
                  </button>
                </div>
              </div>
            )}

            {/* Cliente: por ahora solo pendiente */}
            {!yaGenerado && tipo === "CLIENTE" && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
                <p className="text-amber-800">
                  Los pagos a cliente por ahora se <strong>dejan pendientes</strong> — todavía no generan asiento.
                  El movimiento queda en la lista hasta que definamos qué hacer con estos casos.
                </p>
                <div className="flex justify-end gap-2 mt-3">
                  <button onClick={() => setTipo(null)} className="btn-ghost text-sm">Volver</button>
                  <button onClick={onClose} className="rounded-md bg-brand text-white text-sm font-semibold px-3 py-1.5">
                    Dejar pendiente
                  </button>
                </div>
              </div>
            )}

            {/* Proveedor: builder */}
            {!yaGenerado && tipo === "PROVEEDOR" && (
              <div className="space-y-4">
                {/* Retención */}
                <div className="rounded-md border border-border-soft p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={useRet} onChange={(e) => setUseRet(e.target.checked)} />
                    Retención de honorarios (se suma encima del neto)
                  </label>
                  {useRet && (
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                      <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-xs">
                        <button
                          onClick={() => setRetMode("tasa")}
                          className={`px-2 py-1 ${retMode === "tasa" ? "bg-brand text-white" : "bg-white"}`}
                        >%</button>
                        <button
                          onClick={() => setRetMode("monto")}
                          className={`px-2 py-1 ${retMode === "monto" ? "bg-brand text-white" : "bg-white"}`}
                        >Monto</button>
                      </div>
                      {retMode === "tasa" ? (
                        <label className="flex items-center gap-1">
                          <input
                            type="number" step="0.01" value={retTasa}
                            onChange={(e) => setRetTasa(Number(e.target.value))}
                            className="w-24 rounded-md border border-border-soft px-2 py-1"
                          /> %
                        </label>
                      ) : (
                        <label className="flex items-center gap-1">
                          $<input
                            type="number" step="1" value={retMonto}
                            onChange={(e) => setRetMonto(Number(e.target.value))}
                            className="w-32 rounded-md border border-border-soft px-2 py-1"
                          />
                        </label>
                      )}
                      <span className="text-text-muted">
                        Retención: <span className="font-mono font-semibold">{formatMoney(montoRetencion)}</span>
                        {settings && ` → rubro ${settings.retencionRubro}`}
                      </span>
                    </div>
                  )}
                </div>

                {/* Totales */}
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <Box label="Neto (banco)" value={formatMoney(montoNeto)} />
                  <Box label="Retención" value={formatMoney(montoRetencion)} />
                  <Box label="Bruto a repartir" value={formatMoney(montoBruto)} strong />
                </div>

                {/* Sucursales */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-brand">Reparto por sucursal ({totalPersonas} pers.)</h3>
                    {sucursales.length === 0 && (
                      <span className="text-xs text-rose-700">No hay sucursales. Cargalas en Configuración.</span>
                    )}
                  </div>
                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {sucursales.map((s) => {
                      const checked = sel.has(s.id);
                      const linea = lineas.find((l) => l.id === s.id);
                      return (
                        <div key={s.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${checked ? "border-brand/30 bg-brand/5" : "border-border-soft"}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSel((prev) => {
                                const next = new Map(prev);
                                if (e.target.checked) next.set(s.id, s.headcount);
                                else next.delete(s.id);
                                return next;
                              });
                            }}
                          />
                          <span className="flex-1 truncate">
                            {s.codigo ? `${s.codigo} · ` : ""}{s.nombre}
                          </span>
                          <label className="flex items-center gap-1 text-xs text-text-muted">
                            pers.
                            <input
                              type="number" step="0.5" min="0"
                              value={checked ? (sel.get(s.id) ?? 0) : s.headcount}
                              disabled={!checked}
                              onChange={(e) =>
                                setSel((prev) => {
                                  const next = new Map(prev);
                                  next.set(s.id, Number(e.target.value));
                                  return next;
                                })
                              }
                              className="w-16 rounded-md border border-border-soft px-1.5 py-0.5 disabled:opacity-40"
                            />
                          </label>
                          <span className="w-16 text-right text-xs font-mono text-text-muted">
                            {linea ? `${linea.porcentaje}%` : "—"}
                          </span>
                          <span className="w-28 text-right font-mono font-semibold">
                            {linea ? formatMoney(linea.monto) : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Check de cuadre */}
                <div className={`rounded-md p-2 text-sm text-center font-semibold ${totalLineas === montoBruto ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-rose-50 text-rose-800 border border-rose-200"}`}>
                  DEBE {formatMoney(totalLineas)} {totalLineas === montoBruto ? "=" : "≠"} HABER {formatMoney(montoBruto)}
                  {totalLineas === montoBruto ? " ✔ cuadra" : " — revisá el reparto"}
                </div>

                <div className="flex justify-end gap-2">
                  <button onClick={() => setTipo(null)} disabled={acting} className="btn-ghost text-sm">Volver</button>
                  <button
                    onClick={generar}
                    disabled={acting || lineas.length === 0 || totalLineas !== montoBruto}
                    className="rounded-md bg-brand text-white text-sm font-semibold px-4 py-2 hover:opacity-90 disabled:opacity-50"
                  >
                    {acting ? "Generando…" : "Generar asiento"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function bigAbs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function Box({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md border border-border-soft bg-white px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`font-mono ${strong ? "font-bold text-brand" : ""}`}>{value}</div>
    </div>
  );
}

function GeneradoView({
  asiento,
  onDeshacer,
  acting,
}: {
  asiento: NonNullable<DetailResp["asiento"]>;
  onDeshacer: () => void;
  acting: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm">
        <div className="font-semibold text-emerald-800">Asiento generado · {asiento.tipo}</div>
        <div className="text-xs text-text-muted mt-0.5">
          Neto {formatMoney(BigInt(asiento.montoNeto))}
          {BigInt(asiento.montoRetencion) > 0n && (
            <> · Retención {formatMoney(BigInt(asiento.montoRetencion))}
              {asiento.retencionTasa ? ` (${asiento.retencionTasa}%)` : ""} → rubro {asiento.retencionRubro}</>
          )}
          {" · "}Bruto {formatMoney(BigInt(asiento.montoBruto))}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left">Sucursal</th>
            <th className="px-2 py-1.5 text-right">Personas</th>
            <th className="px-2 py-1.5 text-right">%</th>
            <th className="px-2 py-1.5 text-right">Monto (DEBE)</th>
          </tr>
        </thead>
        <tbody>
          {asiento.lineas.map((l, i) => (
            <tr key={i} className="border-t border-border-soft/60">
              <td className="px-2 py-1.5">{l.sucursalNombre}</td>
              <td className="px-2 py-1.5 text-right">{l.personas}</td>
              <td className="px-2 py-1.5 text-right font-mono">{l.porcentaje}%</td>
              <td className="px-2 py-1.5 text-right font-mono font-semibold">{formatMoney(BigInt(l.monto))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end">
        <button onClick={onDeshacer} disabled={acting} className="text-xs text-rose-700 hover:underline">
          Deshacer asiento
        </button>
      </div>
    </div>
  );
}
