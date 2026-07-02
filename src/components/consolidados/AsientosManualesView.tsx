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
}

interface PendientesResp {
  rows: PendienteRow[];
  totals: { count: number; monto: string };
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
export function AsientosManualesView() {
  const [from, setFrom] = useState(firstDayOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"pendientes" | "generados">("pendientes");

  const [pend, setPend] = useState<PendientesResp | null>(null);
  const [gen, setGen] = useState<GeneradoAsiento[]>([]);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, mode });
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

  // Exporta TODOS los asientos generados del rango como un solo asiento ASI1
  // (mismo criterio que el resto de las tabs). Por cada asiento manual:
  //   DEBE: prorrateo por rubro-sucursal (código de sucursal).
  //   HABER: banco por el neto (rubro resuelto) + retención (rubro 26).
  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (gen.length === 0) return null;
    const lineas: Asi1Linea[] = [];
    for (const a of gen) {
      const detalle = a.glosa || a.counterpartyName || `${a.bankName} ${a.holderName}`;
      if (a.tipo === "CLIENTE") {
        // Ingreso de cliente: DEBE banco / HABER sucursal (1:1, sin impuestos).
        lineas.push({ rubro: a.bancoRubro ?? "", detalle, debe: a.montoNeto });
        for (const l of a.lineas) {
          lineas.push({ rubro: l.rubro ?? "", detalle, haber: l.monto });
        }
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
      options: {
        fecha: to,
        descripcion: `Asientos manuales ${formatDate(from)} al ${formatDate(to)}`,
        lineas,
      },
      filename: `asientos_manuales_${from}_${to}`,
    };
  }

  function exportXlsx() {
    const a = buildAsiento();
    if (a) exportAsi1Xls(a.options, a.filename);
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
      </div>

      {/* Filtros */}
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
              className="rounded-md bg-brand text-white text-sm font-semibold px-3 py-1.5 hover:opacity-90"
            >
              Descargar Excel
            </button>
          </div>
        )}
      </div>

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
