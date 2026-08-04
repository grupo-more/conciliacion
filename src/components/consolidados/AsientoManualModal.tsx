"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatDate, formatMoney } from "@/lib/format";
import { prorratear, calcRetencion } from "@/lib/asientos/prorrateo";
import { usePermisos } from "@/lib/use-permisos";

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
  proveedorNombre,
  onClose,
  onChanged,
}: {
  bankMovementId: string;
  /** Proveedor ya resuelto por el maestro (Configuración → Proveedores) que
   *  derivó este movimiento a la cola "Proveedores". Solo para mostrar. */
  proveedorNombre?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = usePermisos();
  const puedeGenerar = can("generarAsientos");
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
  const [query, setQuery] = useState("");
  const [useRet, setUseRet] = useState(false);
  const [retMode, setRetMode] = useState<"tasa" | "monto">("tasa");
  const [retTasa, setRetTasa] = useState(0);
  const [retMonto, setRetMonto] = useState(0);
  // Glosa del asiento (detalle). Se pre-carga con la descripción del movimiento
  // al elegir "proveedor" y el usuario puede editarla. Si queda vacía, el backend
  // usa la descripción del movimiento por defecto.
  const [glosa, setGlosa] = useState("");
  // Cliente: una sola sucursal seleccionada (su código = rubro del ingreso).
  const [clienteSucursalId, setClienteSucursalId] = useState("");

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
    // Arranca sin ninguna sucursal seleccionada; el usuario elige cuáles.
    setSel(new Map());
    // Pre-cargar la glosa con la descripción del movimiento (editable).
    setGlosa(data?.bankMovement.description ?? "");
  }

  function startCliente() {
    setTipo("CLIENTE");
    setClienteSucursalId("");
    setGlosa(data?.bankMovement.description ?? "");
  }

  function seleccionarTodas() {
    setSel(new Map(sucursales.map((s) => [s.id, s.headcount])));
  }

  function deseleccionarTodas() {
    setSel(new Map());
  }

  // Ordenadas por código (numérico, sin código al final).
  const sucursalesOrdenadas = useMemo(
    () =>
      [...sucursales].sort(
        (a, b) => (a.codigo ?? Infinity) - (b.codigo ?? Infinity),
      ),
    [sucursales],
  );

  // Filtradas por el buscador (solo para mostrar; la selección sigue por id).
  const sucursalesVisibles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sucursalesOrdenadas;
    return sucursalesOrdenadas.filter(
      (s) =>
        s.nombre.toLowerCase().includes(q) ||
        (s.codigo != null && String(s.codigo).includes(q)),
    );
  }, [sucursalesOrdenadas, query]);

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
        glosa: glosa.trim() || null,
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

  // Cliente: banco ↔ sucursal (una sola), sin impuestos.
  async function generarCliente() {
    if (!clienteSucursalId) {
      alert("Elegí una sucursal.");
      return;
    }
    setActing(true);
    try {
      const body = {
        bankMovementId,
        tipo: "CLIENTE" as const,
        glosa: glosa.trim() || null,
        sucursales: [{ sucursalId: clienteSucursalId, personas: 0 }],
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
  // GENERADO o EMITIDO: el asiento existe (read-only). Si está EMITIDO no se
  // puede deshacer suelto (pertenece a una emisión; el backend igual lo bloquea).
  const yaGenerado = data?.asiento?.estado === "GENERADO" || data?.asiento?.estado === "EMITIDO";
  const emitido = data?.asiento?.estado === "EMITIDO";

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
                  {proveedorNombre && (
                    <div className="text-xs mt-0.5">
                      <span className="inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-200 px-2 py-0.5 font-semibold">
                        Proveedor: {proveedorNombre}
                      </span>
                    </div>
                  )}
                  <div className="text-xs text-text-muted mt-0.5">{bm.description}</div>
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

            {/* Ya generado: read-only + deshacer (bloqueado si EMITIDO) */}
            {yaGenerado && data?.asiento && (
              <>
                {emitido && (
                  <div className="rounded-md border border-indigo-200 bg-indigo-50 text-indigo-900 px-3 py-2 text-xs mb-2">
                    Este asiento pertenece a una <b>emisión</b> (documento ya ingresado a gestión). Para
                    deshacerlo, deshacé la emisión completa en Asientos manuales → Emitidos.
                  </div>
                )}
                <GeneradoView
                  asiento={data.asiento}
                  onDeshacer={puedeGenerar && !emitido ? deshacer : undefined}
                  acting={acting}
                />
              </>
            )}

            {/* Sin permiso de generar asientos: solo consulta */}
            {!yaGenerado && !puedeGenerar && (
              <p className="text-sm text-text-muted">
                Este movimiento no tiene contraparte en el sistema. Tu perfil no permite generar asientos.
              </p>
            )}

            {/* Clasificación */}
            {puedeGenerar && !yaGenerado && tipo === null && (
              <div>
                <p className="text-sm text-text-muted mb-3">
                  Este movimiento no tiene contraparte en el sistema. Definí qué es para generar el asiento:
                </p>
                <div className="flex gap-2">
                  <button onClick={startProveedor} className="rounded-md bg-brand text-white text-sm font-semibold px-4 py-2 hover:opacity-90">
                    Pago a proveedor
                  </button>
                  <button onClick={startCliente} className="rounded-md border border-border-soft text-sm font-semibold px-4 py-2 hover:bg-bg-soft">
                    Pago a cliente
                  </button>
                </div>
              </div>
            )}

            {/* Cliente: banco ↔ sucursal (una sola), sin impuestos */}
            {puedeGenerar && !yaGenerado && tipo === "CLIENTE" && (
              <div className="space-y-4">
                <div className="rounded-md border border-border-soft bg-bg-soft/40 p-3 text-sm text-text-muted">
                  Ingreso de cliente: se arma el asiento <b>sucursal (DEBE) ↔ banco (HABER)</b>
                  {" "}(1:1, sin impuestos). Elegí a qué sucursal corresponde este movimiento.
                </div>

                {/* Glosa */}
                <div>
                  <label className="block text-sm font-semibold mb-1">
                    Glosa del asiento{" "}
                    <span className="text-text-muted font-normal">(detalle del ingreso)</span>
                  </label>
                  <input
                    type="text"
                    value={glosa}
                    onChange={(e) => setGlosa(e.target.value)}
                    maxLength={500}
                    placeholder="Ej: Depósito cliente Juan Pérez"
                    className="w-full rounded-md border border-border-soft px-3 py-2 text-sm"
                  />
                </div>

                {/* Sucursal (una) */}
                <div>
                  <label className="block text-sm font-semibold mb-1">Sucursal</label>
                  {sucursales.length === 0 ? (
                    <span className="text-xs text-rose-700">
                      No hay sucursales. Cargalas en Configuración.
                    </span>
                  ) : (
                    <select
                      value={clienteSucursalId}
                      onChange={(e) => setClienteSucursalId(e.target.value)}
                      className="w-full rounded-md border border-border-soft px-3 py-2 text-sm bg-white"
                    >
                      <option value="">— Elegí una sucursal —</option>
                      {sucursalesOrdenadas.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.codigo ? `${s.codigo} · ` : ""}
                          {s.nombre}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="mt-1 text-xs text-text-muted">
                    El código de la sucursal es el rubro que se usa en el asiento.
                  </p>
                </div>

                {/* Resumen: banco (DEBE) ↔ sucursal (HABER) */}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <Box label="Debe · Sucursal" value={formatMoney(montoNeto)} strong />
                  <Box label="Haber · Banco" value={formatMoney(montoNeto)} />
                </div>

                <div className="flex justify-end gap-2">
                  <button onClick={() => setTipo(null)} disabled={acting} className="btn-ghost text-sm">
                    Volver
                  </button>
                  <button
                    onClick={generarCliente}
                    disabled={acting || !clienteSucursalId}
                    className="rounded-md bg-brand text-white text-sm font-semibold px-4 py-2 hover:opacity-90 disabled:opacity-50"
                  >
                    {acting ? "Generando…" : "Generar asiento"}
                  </button>
                </div>
              </div>
            )}

            {/* Proveedor: builder */}
            {puedeGenerar && !yaGenerado && tipo === "PROVEEDOR" && (
              <div className="space-y-4">
                {/* Glosa del asiento (detalle del pago a proveedor) */}
                <div>
                  <label className="block text-sm font-semibold mb-1">
                    Glosa del asiento{" "}
                    <span className="text-text-muted font-normal">(detalle del pago)</span>
                  </label>
                  <input
                    type="text"
                    value={glosa}
                    onChange={(e) => setGlosa(e.target.value)}
                    maxLength={500}
                    placeholder="Ej: Pago honorarios Juan Pérez junio 2026"
                    className="w-full rounded-md border border-border-soft px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    Se guarda en el asiento. Si la dejás vacía, se usa la descripción del
                    movimiento bancario.
                  </p>
                </div>

                {/* Retención */}
                <div className="rounded-md border border-border-soft p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={useRet} onChange={(e) => setUseRet(e.target.checked)} />
                    Retención de honorarios (el banco es líquido → se calcula el bruto)
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

                {/* Totales: Líquido (banco) → Retención → Bruto (lo que reparte la tabla) */}
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <Box label="Líquido (banco)" value={formatMoney(montoNeto)} />
                  <Box label="Retención" value={formatMoney(montoRetencion)} />
                  <Box label="Bruto a repartir" value={formatMoney(montoBruto)} strong />
                </div>

                {/* Sucursales */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-bold text-brand">Reparto por sucursal ({totalPersonas} pers.)</h3>
                    {sucursales.length === 0 ? (
                      <span className="text-xs text-rose-700">No hay sucursales. Cargalas en Configuración.</span>
                    ) : (
                      <div className="flex gap-2 text-xs">
                        <button onClick={seleccionarTodas} className="text-brand font-semibold hover:underline">
                          Seleccionar todas
                        </button>
                        <span className="text-border-soft">·</span>
                        <button onClick={deseleccionarTodas} className="text-text-muted font-semibold hover:underline">
                          Deseleccionar todas
                        </button>
                      </div>
                    )}
                  </div>
                  {sucursales.length > 0 && (
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Buscar sucursal por nombre o código…"
                      className="w-full mb-2 rounded-md border border-border-soft px-2.5 py-1.5 text-sm"
                    />
                  )}
                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {sucursalesVisibles.length === 0 && sucursales.length > 0 && (
                      <p className="text-xs text-text-muted px-1 py-2">Sin resultados para “{query}”.</p>
                    )}
                    {sucursalesVisibles.map((s) => {
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
  onDeshacer?: () => void;
  acting: boolean;
}) {
  const isCliente = asiento.tipo === "CLIENTE";
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm">
        <div className="font-semibold text-emerald-800">Asiento generado · {asiento.tipo}</div>
        {asiento.glosa && (
          <div className="text-xs mt-0.5">
            <span className="text-text-muted">Glosa:</span> {asiento.glosa}
          </div>
        )}
        <div className="text-xs text-text-muted mt-0.5">
          {isCliente ? (
            <>Ingreso <strong>{formatMoney(BigInt(asiento.montoNeto))}</strong> · sucursal (DEBE) ↔ banco (HABER)</>
          ) : (
            <>
              Líquido {formatMoney(BigInt(asiento.montoNeto))}
              {BigInt(asiento.montoRetencion) > 0n && (
                <> · Retención {formatMoney(BigInt(asiento.montoRetencion))}
                  {asiento.retencionTasa ? ` (${asiento.retencionTasa}%)` : ""} → rubro {asiento.retencionRubro}</>
              )}
              {" · "}<strong>Bruto {formatMoney(BigInt(asiento.montoBruto))}</strong> (lo repartido)
            </>
          )}
        </div>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-2 py-1.5 text-left">Sucursal</th>
            {!isCliente && <th className="px-2 py-1.5 text-right">Personas</th>}
            {!isCliente && <th className="px-2 py-1.5 text-right">%</th>}
            <th className="px-2 py-1.5 text-right">Monto (DEBE)</th>
          </tr>
        </thead>
        <tbody>
          {asiento.lineas.map((l, i) => (
            <tr key={i} className="border-t border-border-soft/60">
              <td className="px-2 py-1.5">{l.sucursalNombre}</td>
              {!isCliente && <td className="px-2 py-1.5 text-right">{l.personas}</td>}
              {!isCliente && <td className="px-2 py-1.5 text-right font-mono">{l.porcentaje}%</td>}
              <td className="px-2 py-1.5 text-right font-mono font-semibold">{formatMoney(BigInt(l.monto))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onDeshacer && (
        <div className="flex justify-end">
          <button onClick={onDeshacer} disabled={acting} className="text-xs text-rose-700 hover:underline">
            Deshacer asiento
          </button>
        </div>
      )}
    </div>
  );
}
