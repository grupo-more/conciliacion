"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, type Asi1Linea, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";
import { AsientoManualModal } from "./AsientoManualModal";

interface PendienteRow {
  id: string;
  fecha: string;
  direction: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  description: string | null;
  /** Solo en la cola "proveedores": qué proveedor del maestro lo derivó acá. */
  proveedorNombre?: string;
}

interface PendientesResp {
  rows: PendienteRow[];
  totals: { count: number; monto: string };
  /** Cuántos pendientes quedaron en la OTRA cola (aviso de derivados). */
  derivadosOtraCola?: number;
  facets: { accounts: { id: string; label: string }[] };
}

interface GeneradoAsiento {
  id: string;
  bankMovementId: string;
  tipo: string;
  fecha: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  counterpartyName: string | null;
  glosa: string | null;
  montoNeto: string;
  montoRetencion: string;
  retencionRubro: number | null;
  montoBruto: string;
  /** Rubro contable del banco (HABER del neto), o null si no se resolvió. */
  bancoRubro: number | null;
  lineas: Array<{ sucursalNombre: string; rubro: number | null; personas: number; porcentaje: number; monto: string }>;
}

/**
 * Tab "Asientos manuales" de Consolidados: movimientos de cartola sin
 * contraparte en el sistema, resueltos a mano generando un asiento (proveedor:
 * prorrateo por sucursal; cliente: pendiente).
 */
interface Emision {
  id: string;
  folio: number;
  desde: string;
  hasta: string;
  count: number;
  totalNeto: string;
  totalBruto: string;
  createdAt: string;
}

/**
 * `queue` particiona los pendientes contra el maestro ProveedorAsiento
 * (Configuración → Proveedores): "proveedores" = solo los que matchean (cola
 * delegable con su propio ciclo generados/emitidos), "manual" = el resto.
 */
export function AsientosManualesView({ queue = "manual" }: { queue?: "manual" | "proveedores" }) {
  const esProveedores = queue === "proveedores";
  const origen = esProveedores ? "PROVEEDORES" : "MANUAL";
  const [from, setFrom] = useState(firstDayOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"pendientes" | "generados" | "emitidos">("pendientes");

  const [pend, setPend] = useState<PendientesResp | null>(null);
  const [gen, setGen] = useState<GeneradoAsiento[]>([]);
  const [emisiones, setEmisiones] = useState<Emision[]>([]);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      if (mode === "emitidos") {
        const res = await fetch(`/api/consolidados/asientos-manuales/emisiones?origen=${origen}`);
        setEmisiones(res.ok ? (await res.json()).emisiones ?? [] : []);
        return;
      }
      const p = new URLSearchParams({ from, to, mode, queue });
      if (accountId) p.set("accountId", accountId);
      const res = await fetch(`/api/consolidados/asientos-manuales?${p}`);
      if (!res.ok) {
        setPend(null);
        setGen([]);
        return;
      }
      const j = await res.json();
      if (mode === "generados") setGen(j.asientos ?? []);
      else setPend(j);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, accountId, mode]);

  const totalMonto = useMemo(() => (pend ? BigInt(pend.totals.monto) : 0n), [pend]);

  // Exporta una lista de asientos como un solo asiento ASI1 (mismo criterio que
  // el resto de las tabs). Por cada asiento manual:
  //   DEBE: prorrateo por rubro-sucursal (código de sucursal).
  //   HABER: banco por el neto (rubro resuelto) + retención (rubro 26).
  function buildAsientoFrom(
    lista: GeneradoAsiento[],
    descripcion: string,
    filename: string,
    fechaDoc: string,
  ): { options: Asi1Options; filename: string } | null {
    if (lista.length === 0) return null;
    const lineas: Asi1Linea[] = [];
    for (const a of lista) {
      const detalle = a.glosa || a.counterpartyName || `${a.bankName} ${a.holderName}`;
      if (a.tipo === "CLIENTE") {
        // Ingreso de cliente: DEBE sucursal / HABER banco (1:1, sin impuestos).
        for (const l of a.lineas) {
          lineas.push({ rubro: l.rubro ?? "", detalle, debe: l.monto });
        }
        lineas.push({ rubro: a.bancoRubro ?? "", detalle, haber: a.montoNeto });
      } else {
        // Proveedor: DEBE gasto (prorrateo por sucursal) / HABER banco (+ retención).
        for (const l of a.lineas) {
          lineas.push({ rubro: l.rubro ?? "", detalle, debe: l.monto });
        }
        lineas.push({ rubro: a.bancoRubro ?? "", detalle, haber: a.montoNeto });
        if (BigInt(a.montoRetencion) > 0n) {
          lineas.push({
            rubro: a.retencionRubro ?? "",
            detalle: `Retención honorarios · ${detalle}`,
            haber: a.montoRetencion,
          });
        }
      }
    }
    return {
      options: { fecha: fechaDoc, descripcion, lineas },
      filename,
    };
  }

  const etiqueta = esProveedores ? "Asientos proveedores" : "Asientos manuales";
  const filePrefix = esProveedores ? "asientos_proveedores" : "asientos_manuales";

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    return buildAsientoFrom(
      gen,
      `${etiqueta} ${formatDate(from)} al ${formatDate(to)}`,
      `${filePrefix}_${from}_${to}`,
      to,
    );
  }

  /** Fecha del documento de una emisión: su `hasta` almacenado es fin-EXCLUSIVO
   *  (rango +1 día); el documento original usó el día anterior (el "Hasta" del
   *  filtro al emitir). Reproducirla mantiene el re-download idéntico. */
  function fechaDocDeEmision(e: Emision): string {
    const d = new Date(e.hasta);
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function exportXlsx() {
    const a = buildAsiento();
    if (a) exportAsi1Xls(a.options, a.filename);
  }

  // ---- Emisiones (lote documental, patrón Cuadratura Transbank) ----

  async function emitir() {
    if (gen.length === 0) return;
    if (
      !confirm(
        `Se emitirán ${gen.length} asiento(s) del filtro actual como un documento (folio nuevo). ` +
          `Saldrán de "Generados" y quedarán en la pestaña Emitidos, desde donde se puede ` +
          `re-descargar el documento exacto o deshacer la emisión. ¿Continuar?`,
      )
    )
      return;
    setBusy(true);
    setBanner(null);
    try {
      const res = await fetch(`/api/consolidados/asientos-manuales/emisiones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, accountId: accountId || null, origen }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBanner({ kind: "err", msg: j.error || "Error al emitir" });
        return;
      }
      // Descargar el documento de inmediato (es el mismo que Descargar Excel).
      const a = buildAsientoFrom(
        gen,
        `${etiqueta} · Emisión #${j.folio}`,
        `${filePrefix}_emision_${j.folio}`,
        to,
      );
      if (a) exportAsi1Xls(a.options, a.filename);
      setBanner({ kind: "ok", msg: `Emisión #${j.folio} creada (${j.count} asientos). El documento se descargó.` });
      load();
    } finally {
      setBusy(false);
    }
  }

  async function fetchEmisionAsientos(e: Emision): Promise<GeneradoAsiento[] | null> {
    const res = await fetch(`/api/consolidados/asientos-manuales/emisiones?id=${e.id}`);
    if (!res.ok) {
      setBanner({ kind: "err", msg: "No se pudo cargar la emisión" });
      return null;
    }
    return (await res.json()).asientos ?? [];
  }

  async function verEmision(e: Emision) {
    const asientos = await fetchEmisionAsientos(e);
    if (!asientos) return;
    setPreview(
      buildAsientoFrom(
        asientos,
        `${etiqueta} · Emisión #${e.folio}`,
        `${filePrefix}_emision_${e.folio}`,
        fechaDocDeEmision(e),
      ),
    );
  }

  async function descargarEmision(e: Emision) {
    const asientos = await fetchEmisionAsientos(e);
    if (!asientos) return;
    const a = buildAsientoFrom(
      asientos,
      `${etiqueta} · Emisión #${e.folio}`,
      `${filePrefix}_emision_${e.folio}`,
      fechaDocDeEmision(e),
    );
    if (a) exportAsi1Xls(a.options, a.filename);
  }

  async function deshacerEmision(e: Emision) {
    if (
      !confirm(
        `Deshacer la emisión #${e.folio}? Sus ${e.count} asiento(s) vuelven a "Generados". ` +
          `Hazlo solo si el documento NO fue ingresado al otro sistema (o fue revertido allá).`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/consolidados/asientos-manuales/emisiones?id=${e.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setBanner({ kind: "err", msg: j.error || "Error al deshacer" });
      else {
        setBanner({ kind: "ok", msg: `Emisión #${e.folio} deshecha; los asientos volvieron a Generados.` });
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  // Debounce del término: filtra 180ms después del último tecleo.
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 180);
    return () => clearTimeout(h);
  }, [q]);

  // Búsqueda client-side sobre los pendientes (ya vienen todos cargados).
  // Tolerante a tipeo: ignora tildes/mayúsculas/puntuación, hace match por
  // palabras (orden libre) y aguanta 1 letra de diferencia por palabra (≥4).
  // El monto matchea por dígitos. RUT con o sin puntos/guion.
  const filteredRows = useMemo(() => {
    if (!pend) return [];
    const tokens = norm(debouncedQ).split(" ").filter(Boolean);
    if (tokens.length === 0) return pend.rows;
    return pend.rows.filter((r) => {
      const hay = norm(
        [
          r.counterpartyName,
          r.counterpartyRut,
          r.description,
          r.bankName,
          r.holderName,
          r.accountNumber,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const words = hay.split(" ");
      const digits = [r.monto, r.counterpartyRut, r.accountNumber]
        .filter(Boolean)
        .join(" ")
        .replace(/[^0-9kK]/g, "");
      // Todos los tokens deben matchear (AND).
      return tokens.every((t) => {
        if (/^[0-9kK]+$/.test(t)) return digits.includes(t);
        if (hay.includes(t)) return true;
        if (t.length >= 4) return words.some((w) => withinEdit1(w, t));
        return false;
      });
    });
  }, [pend, debouncedQ]);

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-border-soft overflow-hidden text-sm">
        <button
          onClick={() => setMode("pendientes")}
          className={`px-3 py-1.5 font-semibold ${mode === "pendientes" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
        >
          Pendientes
        </button>
        <button
          onClick={() => setMode("generados")}
          className={`px-3 py-1.5 font-semibold ${mode === "generados" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
        >
          Asientos generados
        </button>
        <button
          onClick={() => setMode("emitidos")}
          className={`px-3 py-1.5 font-semibold ${mode === "emitidos" ? "bg-brand text-white" : "bg-white text-text-muted hover:bg-bg-soft"}`}
        >
          Emitidos
        </button>
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
          <button onClick={() => setBanner(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}

      {/* Filtros (las emisiones no filtran por rango: son lotes ya cerrados) */}
      {mode !== "emitidos" && (
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Desde</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white" />
        </label>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Hasta</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white" />
        </label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white">
          <option value="">Todas las cuentas</option>
          {pend?.facets.accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
        {mode === "pendientes" && (
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar contraparte / RUT / glosa / monto…"
            className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white flex-1 min-w-[220px]"
          />
        )}
        {mode === "pendientes" && pend && (
          <span className="text-xs text-text-muted whitespace-nowrap">
            {debouncedQ.trim() ? `${filteredRows.length} de ${pend.totals.count}` : `${pend.totals.count} sin conciliar`} ·{" "}
            <span className="font-mono">{formatMoney(totalMonto)}</span>
            {(pend.derivadosOtraCola ?? 0) > 0 && (
              <span className="ml-2 text-text-dim" title={esProveedores ? "Pendientes que NO matchean el maestro de proveedores (quedan en Asientos manuales)" : "Pendientes derivados a la tab Proveedores por el maestro de Configuración"}>
                · {pend.derivadosOtraCola} en {esProveedores ? "Asientos manuales" : "Proveedores"}
              </span>
            )}
          </span>
        )}
        {mode === "generados" && gen.length > 0 && (
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setPreview(buildAsiento())}
              className="rounded-md border border-border-soft text-sm font-semibold px-3 py-1.5 hover:bg-bg-soft"
            >
              Vista previa
            </button>
            <button
              onClick={exportXlsx}
              className="rounded-md border border-border-soft text-sm font-semibold px-3 py-1.5 hover:bg-bg-soft"
            >
              Descargar Excel
            </button>
            <button
              onClick={emitir}
              disabled={busy}
              className="rounded-md bg-brand text-white text-sm font-semibold px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
              title="Descarga el documento y mueve estos asientos a la pestaña Emitidos (documento ingresado al otro sistema)"
            >
              {busy ? "Emitiendo…" : `Emitir documento (${gen.length})`}
            </button>
          </div>
        )}
      </div>
      )}

      {loading && <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>}

      {/* Pendientes */}
      {!loading && mode === "pendientes" && (
        <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
          {!pend || pend.rows.length === 0 ? (
            <div className="text-center py-8 text-sm text-text-muted">No hay movimientos sin conciliar en este filtro.</div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-8 text-sm text-text-muted">Sin resultados para “{q}”.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    {esProveedores && <th className="px-3 py-2 text-left">Proveedor</th>}
                    <th className="px-3 py-2 text-left">Cuenta</th>
                    <th className="px-3 py-2 text-left">Dir.</th>
                    <th className="px-3 py-2 text-right">Monto</th>
                    <th className="px-3 py-2 text-left">Contraparte</th>
                    <th className="px-3 py-2 text-left">Glosa</th>
                    <th className="px-3 py-2 text-center">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr key={r.id} onClick={() => setSelected(r.id)} className="border-t border-border-soft/60 hover:bg-bg-soft/40 cursor-pointer">
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(r.fecha)}</td>
                      {esProveedores && (
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span
                            className="inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-200 text-[11px] px-2 py-0.5 font-semibold"
                            title="Proveedor del maestro (Configuración → Proveedores) que derivó este movimiento a esta cola"
                          >
                            {r.proveedorNombre ?? "—"}
                          </span>
                        </td>
                      )}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div>{r.bankName}{r.holderName ? ` ${r.holderName}` : ""}</div>
                        <div className="text-xs text-text-muted font-mono">{r.accountNumber}</div>
                      </td>
                      <td className="px-3 py-2 text-xs">{r.direction}</td>
                      <td className={`px-3 py-2 text-right font-mono whitespace-nowrap ${r.direction === "OUT" ? "text-rose-600" : "text-emerald-700"}`}>
                        {r.direction === "OUT" ? "-" : ""}{formatMoney(BigInt(r.monto))}
                      </td>
                      <td className="px-3 py-2 max-w-[220px] truncate" title={r.counterpartyName ?? ""}>{r.counterpartyName || "—"}</td>
                      <td className="px-3 py-2 max-w-[300px] truncate" title={r.description ?? ""}>{r.description ?? ""}</td>
                      <td className="px-3 py-2 text-center">
                        <span className="text-xs text-brand font-semibold">Generar asiento</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Generados */}
      {!loading && mode === "generados" && (
        <div className="space-y-3">
          {gen.length === 0 ? (
            <div className="rounded-lg border border-border-soft bg-white text-center py-8 text-sm text-text-muted">
              No hay asientos generados en este filtro.
            </div>
          ) : (
            gen.map((a) => (
              <div key={a.id} className="rounded-lg border border-border-soft bg-white p-3 cursor-pointer hover:bg-bg-soft/30" onClick={() => setSelected(a.bankMovementId)}>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold text-sm">
                      {a.bankName} {a.holderName} <span className="text-xs text-text-muted font-normal">· {formatDate(a.fecha)} · {a.tipo}</span>
                    </div>
                    <div className="text-xs text-text-muted">{a.counterpartyName || a.glosa || ""}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-mono font-bold" title="Bruto (lo que se reparte)">{formatMoney(BigInt(a.montoBruto))}</div>
                    {BigInt(a.montoRetencion) > 0n && (
                      <div className="text-xs text-text-muted">
                        líq. {formatMoney(BigInt(a.montoNeto))} · ret. {formatMoney(BigInt(a.montoRetencion))} → r{a.retencionRubro}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-muted">
                  {a.lineas.map((l, i) => (
                    <span key={i}>
                      {l.sucursalNombre} <span className="font-mono">{l.porcentaje}%</span> · <span className="font-mono font-semibold text-text">{formatMoney(BigInt(l.monto))}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Emitidos: lotes documentales (patrón Cuadratura Transbank → Generadas) */}
      {!loading && mode === "emitidos" && (
        <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
          {emisiones.length === 0 ? (
            <div className="text-center py-8 text-sm text-text-muted">
              No hay emisiones. Se crean desde &quot;Asientos generados&quot; con el botón <b>Emitir documento</b>.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Folio</th>
                    <th className="px-3 py-2 text-left">Emitida</th>
                    <th className="px-3 py-2 text-left">Rango</th>
                    <th className="px-3 py-2 text-right">Asientos</th>
                    <th className="px-3 py-2 text-right">Neto</th>
                    <th className="px-3 py-2 text-right">Bruto</th>
                    <th className="px-3 py-2 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {emisiones.map((e) => (
                    <tr key={e.id} className="border-t border-border-soft/60 hover:bg-bg-soft/40">
                      <td className="px-3 py-2 font-mono font-bold whitespace-nowrap">#{e.folio}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-text-muted">
                        {formatDate(e.desde)} → {formatDate(e.hasta)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{e.count}</td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">${formatMoney(BigInt(e.totalNeto))}</td>
                      <td className="px-3 py-2 text-right font-mono whitespace-nowrap">${formatMoney(BigInt(e.totalBruto))}</td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <button onClick={() => verEmision(e)} className="text-brand hover:underline text-xs font-semibold mr-3" title="Ver el documento exacto (con imprimir y descargar)">
                          Ver
                        </button>
                        <button onClick={() => descargarEmision(e)} className="text-brand hover:underline text-xs font-semibold mr-3" title="Re-descargar el Excel ASI1 exacto de esta emisión">
                          Descargar
                        </button>
                        <button onClick={() => deshacerEmision(e)} disabled={busy} className="text-rose-700 hover:underline text-xs font-semibold disabled:opacity-50" title="Los asientos vuelven a Generados">
                          Deshacer
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {selected && (
        <AsientoManualModal
          bankMovementId={selected}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      )}

      {preview && (
        <Asi1PreviewModal
          options={preview.options}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/** Normaliza para búsqueda: sin tildes, minúsculas, solo alfanumérico + espacios. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9k]+/g, " ")
    .trim();
}

/** True si la distancia de edición entre a y b es ≤ 1 (sustitución, inserción
 *  o borrado de un solo carácter). Tolera un error de tipeo por palabra. */
function withinEdit1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la > lb) return withinEdit1(b, a); // asegurar a la más corta
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; }
    else {
      if (++edits > 1) return false;
      if (la === lb) { i++; j++; } // sustitución
      else { j++; } // inserción en b
    }
  }
  if (j < lb) edits += lb - j;
  return edits <= 1;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstDayOfMonthIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
