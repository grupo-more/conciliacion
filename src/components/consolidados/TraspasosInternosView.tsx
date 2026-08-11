"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { exportAsi1Xls, pickDescripcion, buildLineaDetalle, type Asi1Options } from "@/lib/asientos/exportAsi1";
import { Asi1PreviewModal } from "./Asi1Preview";
import { EmisionesPanel, EmisionesToggle, emitirDocumento } from "./EmisionesDerivadas";

type Side = "DEBE" | "HABER";
type IntraFilter = "include" | "exclude" | "only";
type MatchQuality = "clean" | "circle" | "block";

interface TraspasoRow {
  groupId: string;
  side: Side;
  fecha: string;
  rubro: number | null;
  rubroLabel: string | null;
  detalle: string;
  contraparte: string;
  glosa: string;
  monto: string;
  debe: string | null;
  haber: string | null;
  bankMovementId: string;
  matchQuality: MatchQuality;
  intraEntidad: boolean;
}

interface OutOrphan {
  id: string;
  fecha: string;
  cuenta: string;
  rubro: number | null;
  rubroLabel: string | null;
  monto: string;
  contraparte: string;
  glosa: string;
  reason: "no-dest-account" | "no-candidate" | "ambiguous";
  candidatesCount: number;
}

interface InOrphan {
  id: string;
  fecha: string;
  cuenta: string;
  rubro: number | null;
  rubroLabel: string | null;
  monto: string;
  contraparte: string;
  glosa: string;
  entidad: string;
}

interface TraspasosResponse {
  from: string;
  to: string;
  rows: TraspasoRow[];
  totals: { pairs: number; debe: string; haber: string };
  outOrphans: OutOrphan[];
  inOrphans: InOrphan[];
  counts: {
    pairsClean: number;
    pairsCircle: number;
    pairsBlock: number;
    pairsIntra: number;
    outOrphans: number;
    inOrphans: number;
  };
  facets: { accounts: { id: string; label: string }[] };
}

const ORPHAN_REASON: Record<OutOrphan["reason"], string> = {
  "no-dest-account": "Sin cuenta destino",
  "no-candidate": "Sin IN espejo",
  ambiguous: "Ambiguo",
};

/**
 * Tab "Traspasos internos" de Consolidados: cuadra OUT ↔ IN espejo entre
 * cuentas propias. Cada par se muestra como asiento Debe/Haber (estilo
 * Abono Transbank), con los rubros contables resueltos por heuristica.
 * Los OUT/IN sin contraparte van como huerfanos en secciones plegables abajo.
 */
export function TraspasosInternosView() {
  const today = todayIso();
  const monthStart = firstDayOfMonthIso();

  const [from, setFrom] = useState<string>(monthStart);
  const [to, setTo] = useState<string>(today);
  const [accountId, setAccountId] = useState<string>("");
  const [intra, setIntra] = useState<IntraFilter>("include");

  const [data, setData] = useState<TraspasosResponse | null>(null);
  const [preview, setPreview] = useState<{ options: Asi1Options; filename: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [showOutOrphans, setShowOutOrphans] = useState(false);
  const [showInOrphans, setShowInOrphans] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to, intra });
      if (accountId) p.set("accountId", accountId);
      const res = await fetch(`/api/consolidados/traspasos-internos?${p}`);
      if (!res.ok) {
        setData(null);
        return;
      }
      setData(await res.json());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, accountId, intra]);

  const totals = useMemo(() => {
    if (!data) return { debe: 0n, haber: 0n };
    return {
      debe: BigInt(data.totals.debe),
      haber: BigInt(data.totals.haber),
    };
  }, [data]);

  function buildAsiento(): { options: Asi1Options; filename: string } | null {
    if (!data || data.rows.length === 0) return null;
    return {
      options: {
        fecha: to,
        descripcion: `Traspasos internos ${formatDate(from)} al ${formatDate(to)}`,
        lineas: data.rows.map((r) => ({
          rubro: r.rubro ?? "",
          // A diferencia de las otras tabs (donde contraparte = cliente, útil
          // para gestión), acá la contraparte cruda es un RUT o "Internet a
          // XX.XXX.XXX-X" — sin valor en el documento. La descripción correcta
          // de cada línea es la CUENTA DEL OTRO LADO del traspaso (banco ·
          // titular · n° de la contraparte, no la propia — pedido explícito
          // de gestión), igual que la columna Detalle de la vista (route.ts
          // ya arma `detalle` invertido). No hay sucursal para este tab (son
          // transferencias entre cuentas propias, no atadas a una sucursal).
          // La fecha del movimiento va CONCATENADA a la descripción (pedido
          // explícito: no agrandar la tabla con otra columna), PRIMERO y con
          // separador " - " para legibilidad — mismo formato compartido
          // (buildLineaDetalle) que usan las demás tabs. Así también queda en
          // el Excel de gestión y en el snapshot de la emisión. La vista
          // previa/impresión la detectan al inicio y la muestran en negrita.
          detalle: buildLineaDetalle(
            formatDate(r.fecha),
            r.detalle || pickDescripcion(r.contraparte, r.glosa, r.detalle),
          ),
          debe: r.debe,
          haber: r.haber,
        })),
      },
      filename: `traspasos_internos_${from}_${to}`,
    };
  }

  function exportXlsx() {
    const a = buildAsiento();
    if (a) exportAsi1Xls(a.options, a.filename);
  }

  const [verEmitidos, setVerEmitidos] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [emitirErr, setEmitirErr] = useState<string | null>(null);

  async function emitir() {
    const a = buildAsiento();
    if (!a || !data) return;
    const refIds = Array.from(new Set(data.rows.map((r) => r.bankMovementId)));
    if (
      !confirm(
        `Se emitirán ${data.totals.pairs} par(es) de traspaso (${refIds.length} movimientos) como un documento con folio nuevo. ` +
          `Saldrán de esta vista y quedarán en "Emitidos" (re-descargables, deshacer disponible). ¿Continuar?`,
      )
    )
      return;
    setEmitiendo(true);
    setEmitirErr(null);
    try {
      const r = await emitirDocumento({ origen: "TRASPASOS_INTERNOS", from, to, asiento: a, refIds });
      if (!r.ok) setEmitirErr(r.error);
      else load();
    } finally {
      setEmitiendo(false);
    }
  }

  const hasRows = data && data.rows.length > 0;

  if (verEmitidos) {
    return (
      <div className="space-y-4">
        <EmisionesToggle emitidos onChange={setVerEmitidos} />
        <EmisionesPanel origen="TRASPASOS_INTERNOS" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <EmisionesToggle emitidos={false} onChange={setVerEmitidos} />
      {emitirErr && (
        <div className="rounded-lg px-3 py-2 text-sm bg-rose-50 text-rose-800 border border-rose-200">
          {emitirErr}
          <button onClick={() => setEmitirErr(null)} className="ml-2 underline">cerrar</button>
        </div>
      )}
      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Desde</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-text-muted">Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
          />
        </label>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las cuentas</option>
          {data?.facets.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <select
          value={intra}
          onChange={(e) => setIntra(e.target.value as IntraFilter)}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
          title="Filtra los traspasos entre cuentas de la misma entidad (ej. ME→ME en otro banco)"
        >
          <option value="include">Todos los traspasos</option>
          <option value="exclude">Solo cross-entidad</option>
          <option value="only">Solo intra-entidad</option>
        </select>
        {data && (
          <span className="text-xs text-text-muted">
            {data.totals.pairs} par{data.totals.pairs === 1 ? "" : "es"} ·{" "}
            <span className="text-emerald-700">
              {data.counts.pairsClean} limpio{data.counts.pairsClean === 1 ? "" : "s"}
            </span>
            {data.counts.pairsCircle > 0 && (
              <>
                {" + "}
                <span className="text-sky-700">
                  {data.counts.pairsCircle} desambiguado
                  {data.counts.pairsCircle === 1 ? "" : "s"}
                </span>
              </>
            )}
            {data.counts.pairsBlock > 0 && (
              <>
                {" + "}
                <span className="text-amber-700">
                  {data.counts.pairsBlock} pareo por bloque
                </span>
              </>
            )}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => setPreview(buildAsiento())}
          disabled={!hasRows}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm font-semibold hover:bg-bg-soft disabled:opacity-50"
        >
          Vista previa
        </button>
        <button
          onClick={exportXlsx}
          disabled={!hasRows}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm font-semibold hover:bg-bg-soft disabled:opacity-50"
        >
          Descargar Excel
        </button>
        <button
          onClick={emitir}
          disabled={!hasRows || emitiendo}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          title="Descarga el documento y mueve estos pares a Emitidos (documento ingresado al otro sistema)"
        >
          {emitiendo ? "Emitiendo…" : `Emitir documento${data ? ` (${data.totals.pairs})` : ""}`}
        </button>
      </div>

      {/* Tabla principal: pares Debe/Haber */}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">
            Cargando…
          </div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            No hay traspasos internos cuadrados en este rango.
            {data && (data.counts.outOrphans > 0 || data.counts.inOrphans > 0) && (
              <div className="text-xs mt-2">
                Hay {data.counts.outOrphans} OUT y {data.counts.inOrphans} IN
                sin contraparte detectada — revisalos en las secciones de abajo.
              </div>
            )}
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Rubro</th>
                  <th className="px-3 py-2 text-left">Detalle</th>
                  <th className="px-3 py-2 text-left">Contraparte</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                  <th className="px-3 py-2 text-right">Debe</th>
                  <th className="px-3 py-2 text-right">Haber</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((r, idx) => {
                  const prev = idx > 0 ? data!.rows[idx - 1] : null;
                  const isGroupStart = !prev || prev.groupId !== r.groupId;
                  return (
                    <AsientoRow
                      key={`${r.groupId}-${r.side}`}
                      row={r}
                      isGroupStart={isGroupStart}
                    />
                  );
                })}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={5}>
                    TOTAL
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.debe)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totals.haber)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* OUT huerfanos (plegable) */}
      {data && data.outOrphans.length > 0 && (
        <CollapsibleSection
          title={`OUTs sin IN espejo (${data.outOrphans.length})`}
          subtitle="Egresos detectados como internos cuya contraparte no aparecio en la ventana de matching."
          open={showOutOrphans}
          onToggle={() => setShowOutOrphans(!showOutOrphans)}
        >
          <OutOrphansTable orphans={data.outOrphans} />
        </CollapsibleSection>
      )}

      {/* IN huerfanos (plegable) */}
      {data && data.inOrphans.length > 0 && (
        <CollapsibleSection
          title={`INs sin OUT espejo (${data.inOrphans.length})`}
          subtitle="Ingresos detectados como internos cuya contraparte no aparecio en la ventana de matching."
          open={showInOrphans}
          onToggle={() => setShowInOrphans(!showInOrphans)}
        >
          <InOrphansTable orphans={data.inOrphans} />
        </CollapsibleSection>
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

/* =========================== Subcomponentes =============================== */

function AsientoRow({
  row,
  isGroupStart,
}: {
  row: TraspasoRow;
  isGroupStart: boolean;
}) {
  const bg = isGroupStart ? "bg-white" : "bg-bg-soft/40";
  return (
    <tr
      className={
        "text-sm " +
        (isGroupStart ? "border-t-2 border-border-soft/80 " : "") +
        bg
      }
    >
      <td className="px-3 py-1.5 whitespace-nowrap text-text-muted">
        {isGroupStart ? formatDate(row.fecha) : ""}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap font-mono">
        {row.rubro ?? <span className="text-text-dim">—</span>}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        <span>{row.detalle}</span>
        {isGroupStart && (
          <span className="ml-2 inline-flex items-center gap-1">
            {row.intraEntidad ? (
              <span className="inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-300 text-[10px] px-1.5 py-0.5 font-bold">
                INTRA
              </span>
            ) : (
              <span className="inline-block rounded-full bg-violet-100 text-violet-800 border border-violet-300 text-[10px] px-1.5 py-0.5 font-bold">
                CROSS
              </span>
            )}
            {row.matchQuality === "circle" && (
              <span
                className="inline-block rounded-full bg-sky-100 text-sky-800 border border-sky-300 text-[10px] px-1.5 py-0.5 font-bold"
                title="Match desambiguado por cierre del circulo (cpRut del IN coincide con holderRut del origen)"
              >
                ◑ desambig
              </span>
            )}
            {row.matchQuality === "block" && (
              <span
                className="inline-block rounded-full bg-amber-100 text-amber-800 border border-amber-300 text-[10px] px-1.5 py-0.5 font-bold"
                title="Pareo por bloque: varios OUTs/INs indistinguibles entre si, paread os por orden de fecha. El total del bloque cuadra."
              >
                ▤ bloque
              </span>
            )}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 max-w-[220px] truncate" title={row.contraparte}>
        {isGroupStart ? row.contraparte : ""}
      </td>
      <td className="px-3 py-1.5 max-w-[320px] truncate" title={row.glosa}>
        {row.glosa}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.debe ? formatMoney(BigInt(row.debe)) : ""}
      </td>
      <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
        {row.haber ? formatMoney(BigInt(row.haber)) : ""}
      </td>
    </tr>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-bg-soft/60 text-left"
      >
        <div>
          <div className="font-semibold text-sm">{title}</div>
          {subtitle && (
            <div className="text-xs text-text-muted mt-0.5">{subtitle}</div>
          )}
        </div>
        <span className="text-text-muted text-xs">{open ? "▼" : "▶"}</span>
      </button>
      {open && <div className="border-t border-border-soft">{children}</div>}
    </div>
  );
}

function OutOrphansTable({ orphans }: { orphans: OutOrphan[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft/60 text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Rubro</th>
            <th className="px-3 py-2 text-left">Cuenta origen</th>
            <th className="px-3 py-2 text-right">Monto</th>
            <th className="px-3 py-2 text-left">Contraparte</th>
            <th className="px-3 py-2 text-left">Glosa</th>
            <th className="px-3 py-2 text-left">Motivo</th>
          </tr>
        </thead>
        <tbody>
          {orphans.map((o) => (
            <tr key={o.id} className="border-t border-border-soft/60">
              <td className="px-3 py-1.5 whitespace-nowrap">
                {formatDate(o.fecha)}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {o.rubro ?? <span className="text-text-dim">—</span>}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">{o.cuenta}</td>
              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-rose-600">
                -{formatMoney(BigInt(o.monto))}
              </td>
              <td className="px-3 py-1.5 max-w-[220px] truncate" title={o.contraparte}>
                {o.contraparte}
              </td>
              <td className="px-3 py-1.5 max-w-[280px] truncate" title={o.glosa}>
                {o.glosa}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <span className="inline-block rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-[11px] px-2 py-0.5 font-semibold">
                  {ORPHAN_REASON[o.reason]}
                  {o.reason === "ambiguous" && ` (${o.candidatesCount})`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InOrphansTable({ orphans }: { orphans: InOrphan[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft/60 text-xs uppercase tracking-wider text-text-muted">
          <tr>
            <th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Rubro</th>
            <th className="px-3 py-2 text-left">Cuenta destino</th>
            <th className="px-3 py-2 text-right">Monto</th>
            <th className="px-3 py-2 text-left">Contraparte (entidad)</th>
            <th className="px-3 py-2 text-left">Glosa</th>
          </tr>
        </thead>
        <tbody>
          {orphans.map((o) => (
            <tr key={o.id} className="border-t border-border-soft/60">
              <td className="px-3 py-1.5 whitespace-nowrap">
                {formatDate(o.fecha)}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {o.rubro ?? <span className="text-text-dim">—</span>}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">{o.cuenta}</td>
              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap text-emerald-700">
                +{formatMoney(BigInt(o.monto))}
              </td>
              <td
                className="px-3 py-1.5 max-w-[260px] truncate"
                title={`${o.contraparte} (detectado: ${o.entidad})`}
              >
                {o.contraparte || (
                  <span className="text-text-dim">—</span>
                )}{" "}
                <span className="text-xs text-text-muted">({o.entidad})</span>
              </td>
              <td className="px-3 py-1.5 max-w-[280px] truncate" title={o.glosa}>
                {o.glosa}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function firstDayOfMonthIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}
