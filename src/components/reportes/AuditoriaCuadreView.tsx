"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import { printAuditoriaCuenta } from "./AuditoriaPrint";
import { AGING_LABEL, type AgingBucket } from "@/lib/reportes/classify";

interface AccountLite {
  id: string;
  bankCode: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  displayNumber: string | null;
}

interface SaldoManualDTO {
  id: string;
  fecha: string;
  monto: string;
  nota: string | null;
  capturadoPor: string;
  createdAt: string;
}

/** Corte por antiguedad de una lista de pendientes (siempre los 4 buckets). */
interface AgingPorBucket {
  bucket: AgingBucket;
  count: number;
  monto: string;
  neto: string;
}

interface PendienteBancoRow {
  id: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  direction: "IN" | "OUT";
  monto: string;
  counterpartyName: string | null;
  description: string | null;
}

interface PendienteDynatechRow {
  id: string;
  fecha: string;
  aging: number;
  agingBucket: AgingBucket;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  clienteName: string | null;
  glosa: string;
}

interface PendienteBanco {
  count: number;
  monto: string;
  neto: string;
  porAging: AgingPorBucket[];
  rows?: PendienteBancoRow[];
}

interface PendienteDynatech {
  count: number;
  monto: string;
  neto: string;
  porAging: AgingPorBucket[];
  rows?: PendienteDynatechRow[];
}

interface CuentaAuditoria {
  account: AccountLite;
  saldoManual: SaldoManualDTO | null;
  /** false = se esta viendo un snapshot historico, no el vigente. */
  esUltimoSnapshot: boolean;
  saldoSistema: string | null;
  /** Fecha del movimiento de cartola que aporto el saldo banco. */
  saldoBancoFecha: string | null;
  diferencia: string | null;
  pendientes: {
    bancoSinDynatech: PendienteBanco;
    dynatechSinBanco: PendienteDynatech;
  } | null;
  sumaPendientesNeta: string | null;
  diferenciaSinExplicar: string | null;
  cuadra: boolean | null;
}

/**
 * Formatea un monto que viene del API. Tolera `undefined` (campo ausente en el
 * response) y no solo `null`: un guard `!== null` deja pasar el undefined y
 * BigInt(undefined) tumba toda la vista con un error de cliente. Degradar a
 * "—" es siempre preferible a una pagina en blanco.
 */
function moneyOrDash(v: string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return formatMoney(BigInt(v));
}

function cuentaLabel(a: AccountLite): string {
  return `${a.holderName} · ${a.displayNumber || a.accountNumber}`;
}

/**
 * Auditoría de cuadre: compara el saldo de cada cuenta bancaria contra un
 * saldo tipeado a mano (el del otro sistema), a la MISMA fecha, y muestra los
 * pendientes (Banco sin Dynatech + Dynatech sin banco) de esa cuenta para ver
 * si explican la diferencia. Sidebar por cuenta (mismo patrón que Cartolas) +
 * vista general con el resumen de las 7.
 */
export function AuditoriaCuadreView() {
  const [resumen, setResumen] = useState<CuentaAuditoria[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Snapshot de saldo manual que se esta viendo. null = el vigente (el mas
  // reciente). Se setea al clickear una fila del historial, y es lo que hace
  // reproducible una auditoria pasada.
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<CuentaAuditoria | null>(null);
  const [loadingResumen, setLoadingResumen] = useState(false);
  const [loadingDetalle, setLoadingDetalle] = useState(false);

  async function loadResumen() {
    setLoadingResumen(true);
    try {
      const res = await fetch("/api/reportes/auditoria-cuadre");
      if (res.ok) setResumen((await res.json()).cuentas);
    } finally {
      setLoadingResumen(false);
    }
  }

  async function loadDetalle(accountId: string, saldoManualId: string | null) {
    setLoadingDetalle(true);
    try {
      const qs = new URLSearchParams({ accountId });
      if (saldoManualId) qs.set("saldoManualId", saldoManualId);
      const res = await fetch(`/api/reportes/auditoria-cuadre?${qs.toString()}`);
      if (res.ok) setDetalle(await res.json());
    } finally {
      setLoadingDetalle(false);
    }
  }

  /** Cambiar de cuenta siempre vuelve al snapshot vigente de esa cuenta. */
  function seleccionarCuenta(id: string | null) {
    setSelectedId(id);
    setSnapshotId(null);
  }

  useEffect(() => {
    loadResumen();
  }, []);

  useEffect(() => {
    if (selectedId) loadDetalle(selectedId, snapshotId);
    else setDetalle(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, snapshotId]);

  /** Tras guardar o borrar un saldo, se vuelve al vigente: el que se acaba de
   *  cargar pasa a ser el mas reciente, y el borrado puede ser el que se estaba
   *  viendo (quedaria apuntando a un id inexistente). */
  async function refrescarTodo() {
    setSnapshotId(null);
    await loadResumen();
    if (selectedId) await loadDetalle(selectedId, null);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px,1fr] gap-4">
      {/* Sidebar de cuentas */}
      <aside className="card p-3 h-fit">
        <button
          onClick={() => seleccionarCuenta(null)}
          className={`w-full text-left rounded-md px-2 py-2 text-sm mb-2 transition-all ${
            selectedId === null
              ? "bg-brand/10 border border-brand/40 text-brand shadow-sm"
              : "border border-transparent hover:bg-bg-elevated text-text-muted hover:text-text"
          }`}
        >
          <div className="font-semibold">Vista general</div>
          <div className="text-xs text-text-muted">Todas las cuentas</div>
        </button>

        <div className="text-xs text-text-muted mb-2 px-2">Cuentas</div>
        <div className="space-y-0.5">
          {loadingResumen && !resumen && (
            <div className="text-xs text-text-muted px-2 py-2">Cargando…</div>
          )}
          {resumen?.map((c) => {
            const active = c.account.id === selectedId;
            return (
              <button
                key={c.account.id}
                onClick={() => seleccionarCuenta(c.account.id)}
                className={`w-full text-left rounded-md px-2 py-1.5 text-sm transition-all ${
                  active
                    ? "bg-accent/10 border border-accent/40 text-text shadow-sm"
                    : "border border-transparent hover:bg-bg-elevated text-text-muted hover:text-text"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{c.account.bankName}</div>
                    <div className="text-xs text-text-muted truncate">{cuentaLabel(c.account)}</div>
                  </div>
                  <EstadoBadge cuenta={c} compact />
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Panel principal */}
      <div className="min-w-0">
        {selectedId === null ? (
          <VistaGeneral resumen={resumen} loading={loadingResumen} onSelect={seleccionarCuenta} />
        ) : (
          <VistaCuenta
            detalle={detalle}
            loading={loadingDetalle}
            onSaved={refrescarTodo}
            snapshotId={snapshotId}
            onSelectSnapshot={setSnapshotId}
          />
        )}
      </div>
    </div>
  );
}

function EstadoBadge({ cuenta, compact }: { cuenta: CuentaAuditoria; compact?: boolean }) {
  if (cuenta.cuadra === null) {
    return (
      <span
        className="inline-block rounded-full bg-bg-soft text-text-muted border border-border-soft text-[10px] px-1.5 py-0.5 font-semibold shrink-0"
        title="Todavía no se cargó un saldo manual para esta cuenta"
      >
        Sin dato
      </span>
    );
  }
  if (cuenta.cuadra) {
    return (
      <span className="inline-block rounded-full bg-success/10 text-success border border-success/40 text-[10px] px-1.5 py-0.5 font-semibold shrink-0">
        ✓ Cuadra
      </span>
    );
  }
  const monto = cuenta.diferenciaSinExplicar ? formatMoney(BigInt(cuenta.diferenciaSinExplicar)) : "";
  return (
    <span
      className="inline-block rounded-full bg-rose-50 text-rose-700 border border-rose-300 text-[10px] px-1.5 py-0.5 font-semibold shrink-0"
      title="Diferencia sin explicar por los pendientes"
    >
      {compact ? "⚠" : `⚠ ${monto}`}
    </span>
  );
}

function VistaGeneral({
  resumen,
  loading,
  onSelect,
}: {
  resumen: CuentaAuditoria[] | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Auditoría de cuadre — Vista general</h2>
          <p className="text-xs text-text-muted">
            Saldo del sistema vs. saldo tipeado a mano (del otro sistema), por cuenta.
          </p>
        </div>
        {resumen && resumen.length > 0 && (
          <button
            onClick={() => printAuditoriaCuenta(resumen)}
            className="btn-ghost text-sm"
          >
            Descargar PDF (todas)
          </button>
        )}
      </div>

      {loading && !resumen && <div className="card text-sm text-text-muted">Cargando…</div>}

      {resumen && (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
              <tr>
                <th className="px-3 py-2 text-left">Cuenta</th>
                <th className="px-3 py-2 text-left">Saldo manual (fecha)</th>
                <th className="px-3 py-2 text-right">Saldo Banco</th>
                <th className="px-3 py-2 text-right">Saldo manual</th>
                <th className="px-3 py-2 text-right">Diferencia</th>
                <th className="px-3 py-2 text-right">Pendientes (neto)</th>
                <th className="px-3 py-2 text-center">Estado</th>
              </tr>
            </thead>
            <tbody>
              {resumen.map((c) => (
                <tr
                  key={c.account.id}
                  onClick={() => onSelect(c.account.id)}
                  className="border-t border-border-soft/40 hover:bg-bg-elevated/40 cursor-pointer"
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.account.bankName}</div>
                    <div className="text-xs text-text-muted">{cuentaLabel(c.account)}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-text-muted">
                    {c.saldoManual ? formatDate(c.saldoManual.fecha) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {moneyOrDash(c.saldoSistema)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.saldoManual ? moneyOrDash(c.saldoManual.monto) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {moneyOrDash(c.diferencia)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-muted">
                    {moneyOrDash(c.sumaPendientesNeta)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <EstadoBadge cuenta={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VistaCuenta({
  detalle,
  loading,
  onSaved,
  snapshotId,
  onSelectSnapshot,
}: {
  detalle: CuentaAuditoria | null;
  loading: boolean;
  onSaved: () => void;
  snapshotId: string | null;
  onSelectSnapshot: (id: string | null) => void;
}) {
  const [fecha, setFecha] = useState(todayIso());
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Pre-cargar el form con el último saldo conocido, para "actualizar" fácil.
    if (detalle?.saldoManual) {
      setFecha(detalle.saldoManual.fecha);
      setMonto(detalle.saldoManual.monto);
      setNota(detalle.saldoManual.nota ?? "");
    } else {
      setFecha(todayIso());
      setMonto("");
      setNota("");
    }
  }, [detalle?.account.id, detalle?.saldoManual?.id]);

  async function guardar() {
    if (!detalle || !monto.trim()) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/reportes/saldo-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: detalle.account.id,
          fecha,
          monto: monto.trim(),
          nota: nota.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || "No se pudo guardar el saldo manual");
        return;
      }
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (loading && !detalle) {
    return <div className="card text-sm text-text-muted">Cargando…</div>;
  }
  if (!detalle) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{detalle.account.bankName}</h2>
          <p className="text-xs text-text-muted">{cuentaLabel(detalle.account)}</p>
        </div>
        <button
          onClick={() => printAuditoriaCuenta([detalle])}
          className="btn-ghost text-sm"
        >
          Descargar PDF
        </button>
      </div>

      {/* Formulario de saldo manual */}
      <div className="card space-y-3">
        <div className="text-sm font-semibold">Saldo según el otro sistema</div>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="label">Fecha</label>
            <input type="date" className="input" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="label">Monto</label>
            <input
              type="number"
              className="input"
              placeholder="Ej: 146051272"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
            />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="label">Nota (opcional)</label>
            <input
              type="text"
              className="input"
              placeholder="Ej: según cartilla gestión al cierre"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
            />
          </div>
          <button onClick={guardar} disabled={saving || !monto.trim()} className="btn-primary">
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
        {err && <div className="text-xs text-rose-600">{err}</div>}
        {detalle.saldoManual && (
          <div className="text-xs text-text-muted">
            Último cargado por <b>{detalle.saldoManual.capturadoPor}</b> el{" "}
            {formatDate(detalle.saldoManual.createdAt)}
            {detalle.saldoManual.nota ? ` — "${detalle.saldoManual.nota}"` : ""}
          </div>
        )}
      </div>

      <HistorialSaldos
        accountId={detalle.account.id}
        onChanged={onSaved}
        viendoId={detalle.saldoManual?.id ?? null}
        snapshotId={snapshotId}
        onSelectSnapshot={onSelectSnapshot}
      />

      {!detalle.saldoManual ? (
        <div className="card text-sm text-text-muted">
          Carga un saldo manual arriba para ver la comparación y los pendientes de esta cuenta.
        </div>
      ) : (
        <>
          {/* Aviso: se esta viendo un snapshot historico, no el vigente. */}
          {!detalle.esUltimoSnapshot && (
            <div className="card bg-amber-50/60 border-amber-300/60 flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="text-xs text-amber-900">
                Estás viendo la auditoría reproducida al{" "}
                <b>{formatDate(detalle.saldoManual.fecha)}</b>, no el saldo vigente.
              </div>
              <button onClick={() => onSelectSnapshot(null)} className="btn-ghost text-xs">
                Volver al vigente
              </button>
            </div>
          )}

          {/* Comparación */}
          <div className="card">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat
                label={`Saldo Banco (${formatDate(detalle.saldoManual.fecha)})`}
                value={detalle.saldoSistema}
                sub={
                  detalle.saldoBancoFecha
                    ? `según cartola al ${formatDate(detalle.saldoBancoFecha)}`
                    : "sin cartola cargada"
                }
              />
              <Stat label="Saldo manual" value={detalle.saldoManual.monto} />
              <Stat label="Diferencia" value={detalle.diferencia} />
              <Stat label="Pendientes explican" value={detalle.sumaPendientesNeta} sub="suma neta" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <EstadoBadge cuenta={detalle} />
              {detalle.cuadra === false && (
                <span className="text-xs text-rose-700">
                  Diferencia sin explicar: {moneyOrDash(detalle.diferenciaSinExplicar)}
                </span>
              )}
            </div>
            {/* La cartola no llega hasta la fecha de corte: la diferencia
                incluye dias que no estan cargados en el sistema. */}
            {detalle.saldoBancoFecha && detalle.saldoBancoFecha < detalle.saldoManual.fecha && (
              <div className="mt-2 text-xs text-amber-800">
                ⚠ La cartola de esta cuenta llega hasta el{" "}
                <b>{formatDate(detalle.saldoBancoFecha)}</b> y el corte es al{" "}
                <b>{formatDate(detalle.saldoManual.fecha)}</b>. La diferencia incluye días
                todavía no cargados.
              </div>
            )}
          </div>

          {/* Pendientes */}
          <PendientesBanco pendiente={detalle.pendientes?.bancoSinDynatech} />
          <PendientesDynatech pendiente={detalle.pendientes?.dynatechSinBanco} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | null | undefined; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className="text-base font-bold tabular-nums font-mono">
        {moneyOrDash(value)}
      </div>
      {sub && <div className="text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

/**
 * Corte por antiguedad de los pendientes. Es un control de VISTA, no de
 * calculo: filtra las filas mostradas pero el count y el neto del encabezado
 * siguen siendo los totales completos. Acotar el universo de pendientes
 * romperia la aritmetica de "los pendientes explican la diferencia" (el saldo
 * del banco arrastra toda la historia de la cuenta), y ademas esconderia los
 * pendientes viejos, que son justo los que mas importan en una auditoria.
 */
function AgingChips({
  porAging,
  sel,
  onSel,
  total,
  mostradas,
}: {
  porAging?: AgingPorBucket[];
  sel: AgingBucket | null;
  onSel: (b: AgingBucket | null) => void;
  total: number;
  mostradas: number;
}) {
  const buckets = (porAging ?? []).filter((b) => b.count > 0);
  if (buckets.length === 0) return null;

  return (
    <div className="px-3 py-2 border-b border-border-soft bg-bg-soft/40">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mr-1">
          Antigüedad
        </span>
        <button onClick={() => onSel(null)} className={chipClass(sel === null)}>
          Todos <span className="text-text-muted">({total})</span>
        </button>
        {buckets.map((b) => (
          <button
            key={b.bucket}
            onClick={() => onSel(sel === b.bucket ? null : b.bucket)}
            className={chipClass(sel === b.bucket)}
            title={`Neto de este tramo: ${moneyOrDash(b.neto)}`}
          >
            {b.bucket === "60+" && <span className="text-rose-600 mr-0.5">⚠</span>}
            {AGING_LABEL[b.bucket]} <span className="text-text-muted">({b.count})</span>
            <span className="font-mono ml-1">{moneyOrDash(b.neto)}</span>
          </button>
        ))}
      </div>
      {sel !== null && (
        <div className="mt-1.5 text-[10px] text-text-muted">
          Mostrando {mostradas} de {total} — el conteo y el neto del encabezado siguen siendo
          el total completo.
        </div>
      )}
    </div>
  );
}

function chipClass(active: boolean): string {
  return `text-[11px] rounded-full px-2 py-0.5 border transition-colors ${
    active
      ? "bg-brand/10 border-brand/40 text-brand font-semibold"
      : "border-border-soft text-text-muted hover:bg-bg-elevated hover:text-text"
  }`;
}

function PendientesBanco({ pendiente }: { pendiente?: PendienteBanco }) {
  const [bucket, setBucket] = useState<AgingBucket | null>(null);
  const todas = pendiente?.rows ?? [];
  const rows = bucket ? todas.filter((r) => r.agingBucket === bucket) : todas;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-border-soft flex items-center justify-between">
        <div className="text-sm font-semibold">
          Bancos sin Dynatech <span className="text-text-muted font-normal">({pendiente?.count ?? 0})</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          neto {pendiente ? moneyOrDash(pendiente.neto) : "$0"}
        </div>
      </div>
      <AgingChips
        porAging={pendiente?.porAging}
        sel={bucket}
        onSel={setBucket}
        total={todas.length}
        mostradas={rows.length}
      />
      {todas.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">Sin pendientes de este lado.</div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">
          Ningún pendiente en ese tramo de antigüedad.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-1.5 text-left">Fecha</th>
                <th className="px-3 py-1.5 text-right">Días</th>
                <th className="px-3 py-1.5 text-center">Dir.</th>
                <th className="px-3 py-1.5 text-right">Monto</th>
                <th className="px-3 py-1.5 text-left">Contraparte</th>
                <th className="px-3 py-1.5 text-left">Glosa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border-soft/40">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(r.fecha)}</td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      r.agingBucket === "60+" ? "text-rose-600 font-semibold" : "text-text-muted"
                    }`}
                  >
                    {r.aging}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={r.direction === "IN" ? "text-success" : "text-rose-600"}>
                      {r.direction}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{moneyOrDash(r.monto)}</td>
                  <td className="px-3 py-1.5 truncate max-w-[200px]">{r.counterpartyName ?? "—"}</td>
                  <td className="px-3 py-1.5 truncate max-w-[240px]">{r.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PendientesDynatech({ pendiente }: { pendiente?: PendienteDynatech }) {
  const [bucket, setBucket] = useState<AgingBucket | null>(null);
  const todas = pendiente?.rows ?? [];
  const rows = bucket ? todas.filter((r) => r.agingBucket === bucket) : todas;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-border-soft flex items-center justify-between">
        <div className="text-sm font-semibold">
          Dynatech sin banco <span className="text-text-muted font-normal">({pendiente?.count ?? 0})</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          neto {pendiente ? moneyOrDash(pendiente.neto) : "$0"}
        </div>
      </div>
      <AgingChips
        porAging={pendiente?.porAging}
        sel={bucket}
        onSel={setBucket}
        total={todas.length}
        mostradas={rows.length}
      />
      {todas.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">Sin pendientes de este lado.</div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">
          Ningún pendiente en ese tramo de antigüedad.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-1.5 text-left">Fecha</th>
                <th className="px-3 py-1.5 text-right">Días</th>
                <th className="px-3 py-1.5 text-center">Tipo</th>
                <th className="px-3 py-1.5 text-right">Monto</th>
                <th className="px-3 py-1.5 text-left">Cliente</th>
                <th className="px-3 py-1.5 text-left">Glosa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border-soft/40">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(r.fecha)}</td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      r.agingBucket === "60+" ? "text-rose-600 font-semibold" : "text-text-muted"
                    }`}
                  >
                    {r.aging}
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <span className={r.tipoOperacion === "INGRESO" ? "text-success" : "text-rose-600"}>
                      {r.tipoOperacion}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{moneyOrDash(r.monto)}</td>
                  <td className="px-3 py-1.5 truncate max-w-[200px]">{r.clienteName ?? "—"}</td>
                  <td className="px-3 py-1.5 truncate max-w-[240px]">{r.glosa}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Historial de saldos manuales. Cada fila es clickeable: reproduce la auditoria
 * completa a la fecha de ese snapshot. Sin esto el reporte no es auditable —
 * cargar un saldo nuevo cambiaba lo que mostraba el reporte sin forma de volver
 * a ver lo que se vio en su momento.
 */
function HistorialSaldos({
  accountId,
  onChanged,
  viendoId,
  snapshotId,
  onSelectSnapshot,
}: {
  accountId: string;
  onChanged: () => void;
  /** Id del snapshot que el detalle esta mostrando ahora. */
  viendoId: string | null;
  snapshotId: string | null;
  onSelectSnapshot: (id: string | null) => void;
}) {
  const [saldos, setSaldos] = useState<SaldoManualDTO[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    const res = await fetch(`/api/reportes/saldo-manual?accountId=${accountId}`);
    if (res.ok) setSaldos((await res.json()).saldos);
  }

  useEffect(() => {
    setSaldos(null);
    setOpen(false);
  }, [accountId]);

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  // Si se esta viendo un snapshot historico, el historial se abre solo para que
  // quede visible cual de todos es.
  useEffect(() => {
    if (snapshotId) setOpen(true);
  }, [snapshotId]);

  async function eliminar(id: string) {
    if (!confirm("¿Eliminar este saldo manual? No se puede deshacer.")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/reportes/saldo-manual?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        await load();
        await onChanged();
      }
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="card p-0 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2 text-left text-sm font-semibold flex items-center justify-between hover:bg-bg-elevated/40"
      >
        <span>
          Historial de saldos manuales
          <span className="ml-2 text-xs font-normal text-text-muted">
            click en una fila para reproducir la auditoría a esa fecha
          </span>
        </span>
        <span className="text-text-muted text-xs">{open ? "ocultar ▲" : "ver ▼"}</span>
      </button>
      {open && (
        <div className="border-t border-border-soft overflow-x-auto">
          {saldos === null ? (
            <div className="px-3 py-3 text-sm text-text-muted">Cargando…</div>
          ) : saldos.length === 0 ? (
            <div className="px-3 py-3 text-sm text-text-muted">Sin registros todavía.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase text-text-muted">
                <tr>
                  <th className="px-3 py-1.5 text-left">Fecha</th>
                  <th className="px-3 py-1.5 text-right">Monto</th>
                  <th className="px-3 py-1.5 text-left">Nota</th>
                  <th className="px-3 py-1.5 text-left">Cargado por</th>
                  <th className="px-3 py-1.5 text-center">Viendo</th>
                  <th className="px-3 py-1.5 text-center">Acción</th>
                </tr>
              </thead>
              <tbody>
                {saldos.map((s) => {
                  const activo = s.id === viendoId;
                  return (
                    <tr
                      key={s.id}
                      onClick={() => onSelectSnapshot(s.id)}
                      title="Reproducir la auditoría a esta fecha"
                      className={`border-t border-border-soft/40 cursor-pointer transition-colors ${
                        activo ? "bg-brand/5" : "hover:bg-bg-elevated/40"
                      }`}
                    >
                      <td className="px-3 py-1.5 whitespace-nowrap">{formatDate(s.fecha)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{moneyOrDash(s.monto)}</td>
                      <td className="px-3 py-1.5 text-text-muted">{s.nota ?? "—"}</td>
                      <td className="px-3 py-1.5 text-xs text-text-muted whitespace-nowrap">
                        {s.capturadoPor} · {formatDate(s.createdAt)}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {activo ? (
                          <span className="text-[10px] font-semibold text-brand uppercase tracking-wider">
                            ● Viendo
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">ver</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            eliminar(s.id);
                          }}
                          disabled={deletingId === s.id}
                          className="text-rose-700 hover:underline text-xs font-semibold disabled:opacity-50"
                        >
                          {deletingId === s.id ? "Eliminando…" : "Eliminar"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
