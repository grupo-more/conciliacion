"use client";

import { useEffect, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";
import { printAuditoriaCuenta } from "./AuditoriaPrint";

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

interface PendienteBancoRow {
  id: string;
  fecha: string;
  aging: number;
  direction: "IN" | "OUT";
  monto: string;
  counterpartyName: string | null;
  description: string | null;
}

interface PendienteDynatechRow {
  id: string;
  fecha: string;
  aging: number;
  tipoOperacion: "INGRESO" | "EGRESO";
  monto: string;
  clienteName: string | null;
  glosa: string;
}

interface CuentaAuditoria {
  account: AccountLite;
  saldoManual: SaldoManualDTO | null;
  saldoSistema: string | null;
  diferencia: string | null;
  pendientes: {
    bancoSinDynatech: { count: number; monto: string; neto: string; rows?: PendienteBancoRow[] };
    dynatechSinBanco: { count: number; monto: string; neto: string; rows?: PendienteDynatechRow[] };
  } | null;
  sumaPendientesNeta: string | null;
  diferenciaSinExplicar: string | null;
  cuadra: boolean | null;
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

  async function loadDetalle(accountId: string) {
    setLoadingDetalle(true);
    try {
      const res = await fetch(`/api/reportes/auditoria-cuadre?accountId=${accountId}`);
      if (res.ok) setDetalle(await res.json());
    } finally {
      setLoadingDetalle(false);
    }
  }

  useEffect(() => {
    loadResumen();
  }, []);

  useEffect(() => {
    if (selectedId) loadDetalle(selectedId);
    else setDetalle(null);
  }, [selectedId]);

  async function refrescarTodo() {
    await loadResumen();
    if (selectedId) await loadDetalle(selectedId);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px,1fr] gap-4">
      {/* Sidebar de cuentas */}
      <aside className="card p-3 h-fit">
        <button
          onClick={() => setSelectedId(null)}
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
                onClick={() => setSelectedId(c.account.id)}
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
          <VistaGeneral resumen={resumen} loading={loadingResumen} onSelect={setSelectedId} />
        ) : (
          <VistaCuenta
            detalle={detalle}
            loading={loadingDetalle}
            onSaved={refrescarTodo}
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
                <th className="px-3 py-2 text-right">Saldo sistema</th>
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
                    {c.saldoSistema !== null ? formatMoney(BigInt(c.saldoSistema)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.saldoManual ? formatMoney(BigInt(c.saldoManual.monto)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.diferencia !== null ? formatMoney(BigInt(c.diferencia)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-muted">
                    {c.sumaPendientesNeta !== null ? formatMoney(BigInt(c.sumaPendientesNeta)) : "—"}
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
}: {
  detalle: CuentaAuditoria | null;
  loading: boolean;
  onSaved: () => void;
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

      {!detalle.saldoManual ? (
        <div className="card text-sm text-text-muted">
          Carga un saldo manual arriba para ver la comparación y los pendientes de esta cuenta.
        </div>
      ) : (
        <>
          {/* Comparación */}
          <div className="card">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label={`Saldo sistema (${formatDate(detalle.saldoManual.fecha)})`} value={detalle.saldoSistema} />
              <Stat label="Saldo manual" value={detalle.saldoManual.monto} />
              <Stat label="Diferencia" value={detalle.diferencia} />
              <Stat label="Pendientes explican" value={detalle.sumaPendientesNeta} sub="suma neta" />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <EstadoBadge cuenta={detalle} />
              {detalle.cuadra === false && (
                <span className="text-xs text-rose-700">
                  Diferencia sin explicar: {detalle.diferenciaSinExplicar ? formatMoney(BigInt(detalle.diferenciaSinExplicar)) : "—"}
                </span>
              )}
            </div>
          </div>

          {/* Pendientes */}
          <PendientesBanco pendiente={detalle.pendientes?.bancoSinDynatech} />
          <PendientesDynatech pendiente={detalle.pendientes?.dynatechSinBanco} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | null; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className="text-base font-bold tabular-nums font-mono">
        {value !== null ? formatMoney(BigInt(value)) : "—"}
      </div>
      {sub && <div className="text-[10px] text-text-muted">{sub}</div>}
    </div>
  );
}

function PendientesBanco({
  pendiente,
}: {
  pendiente?: { count: number; monto: string; neto: string; rows?: PendienteBancoRow[] };
}) {
  const rows = pendiente?.rows ?? [];
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-border-soft flex items-center justify-between">
        <div className="text-sm font-semibold">
          Bancos sin Dynatech <span className="text-text-muted font-normal">({pendiente?.count ?? 0})</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          neto {pendiente ? formatMoney(BigInt(pendiente.neto)) : "$0"}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">Sin pendientes de este lado.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-1.5 text-left">Fecha</th>
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
                  <td className="px-3 py-1.5 text-center">
                    <span className={r.direction === "IN" ? "text-success" : "text-rose-600"}>
                      {r.direction}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatMoney(BigInt(r.monto))}</td>
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

function PendientesDynatech({
  pendiente,
}: {
  pendiente?: { count: number; monto: string; neto: string; rows?: PendienteDynatechRow[] };
}) {
  const rows = pendiente?.rows ?? [];
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-border-soft flex items-center justify-between">
        <div className="text-sm font-semibold">
          Dynatech sin banco <span className="text-text-muted font-normal">({pendiente?.count ?? 0})</span>
        </div>
        <div className="text-xs text-text-muted font-mono">
          neto {pendiente ? formatMoney(BigInt(pendiente.neto)) : "$0"}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-sm text-text-muted">Sin pendientes de este lado.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-soft text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-1.5 text-left">Fecha</th>
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
                  <td className="px-3 py-1.5 text-center">
                    <span className={r.tipoOperacion === "INGRESO" ? "text-success" : "text-rose-600"}>
                      {r.tipoOperacion}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">{formatMoney(BigInt(r.monto))}</td>
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

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
