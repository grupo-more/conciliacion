"use client";

import { useEffect, useState } from "react";
import { DetailModal } from "./DetailModal";
import { BranchHints } from "./BranchHints";
import type {
  ReconciliationDTO,
  ReconciliationListResponse,
  ReconciliationStatus,
  OtherBankCreditsResponse,
} from "./types";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";

type Tab = ReconciliationStatus | "OTHER_BANK_CREDITS";

const TABS: Array<{
  id: Tab;
  label: string;
  countKey?: ReconciliationStatus | "UNPROCESSED";
  colorClass?: string;
  description: string;
}> = [
  {
    id: "AUTO_MATCHED",
    label: "Conciliados (auto)",
    countKey: "AUTO_MATCHED",
    colorClass: "text-success",
    description: "Match automático con alta certeza. No requiere acción.",
  },
  {
    id: "MANUAL",
    label: "Conciliados (manual)",
    countKey: "MANUAL",
    colorClass: "text-success",
    description: "Confirmados por gerencia.",
  },
  {
    id: "SUGGESTED",
    label: "Sugeridos",
    countKey: "SUGGESTED",
    colorClass: "text-accent",
    description: "Match propuesto, requiere aprobación.",
  },
  {
    id: "REVIEW",
    label: "Revisar",
    countKey: "REVIEW",
    colorClass: "text-warn",
    description: "Hay varios candidatos, elige cuál corresponde.",
  },
  {
    id: "NO_MATCH",
    label: "Sin match",
    countKey: "NO_MATCH",
    colorClass: "text-text-muted",
    description: "Sin candidatos. Se reintenta automáticamente al subir cartolas nuevas.",
  },
  {
    id: "OUT_OF_SCOPE",
    label: "Fuera de scope",
    countKey: "OUT_OF_SCOPE",
    colorClass: "text-text-muted",
    description: "Bancos no registrados en el sistema.",
  },
  {
    id: "OTHER_BANK_CREDITS",
    label: "Otros abonos banco",
    description: "Abonos bancarios sin contraparte Dynatech (panel informativo).",
  },
];

export function ConciliacionView() {
  const [tab, setTab] = useState<Tab>("SUGGESTED");
  const [data, setData] = useState<ReconciliationListResponse | null>(null);
  const [otherCredits, setOtherCredits] = useState<OtherBankCreditsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showHints, setShowHints] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      if (tab === "OTHER_BANK_CREDITS") {
        const res = await fetch("/api/reconciliation/other-bank-credits?limit=500");
        if (res.ok) setOtherCredits(await res.json());
      } else {
        const res = await fetch(`/api/reconciliation?status=${tab}&limit=500`);
        if (res.ok) setData(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadCounts() {
    // Carga la primera tab para tener counts
    const res = await fetch(`/api/reconciliation?status=AUTO_MATCHED&limit=1`);
    if (res.ok) {
      const j: ReconciliationListResponse = await res.json();
      setData((prev) => (prev ? { ...prev, counts: j.counts } : prev));
    }
  }

  async function runMatching() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/reconciliation/run", { method: "POST" });
      const j = await res.json();
      setRunResult(
        `Procesados ${j.processed} · Auto ${j.autoMatched} · Sug ${j.suggested} · Rev ${j.review} · Sin ${j.noMatch} · Fuera ${j.outOfScope}`
      );
      await loadData();
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-cerrar banner
  useEffect(() => {
    if (runResult) {
      const t = setTimeout(() => setRunResult(null), 5000);
      return () => clearTimeout(t);
    }
  }, [runResult]);

  const counts = data?.counts;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 animate-fade-in-down">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Conciliación</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Cruce de Ventas Dynatech con abonos bancarios.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowHints(true)}
            className="btn-ghost"
          >
            Sucursales y cuentas
          </button>
          <button
            onClick={runMatching}
            disabled={running}
            className="btn-primary"
          >
            {running ? "Procesando…" : "Procesar matching"}
          </button>
        </div>
      </div>

      {runResult && (
        <div className="rounded-md border border-success/40 bg-success/10 p-3 text-sm text-success">
          ✓ {runResult}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border-soft animate-fade-in">
        {TABS.map((t) => {
          const active = t.id === tab;
          let count: number | undefined;
          if (t.countKey && counts) count = counts[t.countKey];
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "px-4 py-2.5 text-sm border-b-2 -mb-px transition-all duration-200 ease-out " +
                (active
                  ? "border-accent text-text font-medium"
                  : "border-transparent text-text-muted hover:text-text hover:border-border")
              }
            >
              {t.label}
              {count !== undefined && (
                <span
                  className={
                    "ml-2 text-xs " +
                    (active ? t.colorClass ?? "" : "text-text-muted")
                  }
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="text-xs text-text-muted">
        {TABS.find((t) => t.id === tab)?.description}
      </div>

      {/* Contenido por tab */}
      {tab === "OTHER_BANK_CREDITS" ? (
        <OtherCreditsTable
          loading={loading}
          data={otherCredits}
        />
      ) : (
        <ReconciliationsTable
          loading={loading}
          rows={data?.rows ?? []}
          tab={tab}
          onOpen={setSelectedId}
        />
      )}

      {selectedId && (
        <DetailModal
          reconciliationId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            loadData();
            loadCounts();
          }}
        />
      )}

      {showHints && <BranchHints onClose={() => setShowHints(false)} />}
    </div>
  );
}

function ReconciliationsTable({
  loading,
  rows,
  tab,
  onOpen,
}: {
  loading: boolean;
  rows: ReconciliationDTO[];
  tab: ReconciliationStatus | "OTHER_BANK_CREDITS";
  onOpen: (id: string) => void;
}) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
          <tr>
            <th className="px-3 py-2 text-left">Fecha Dynatech</th>
            <th className="px-3 py-2 text-left">Sucursal · Cajero</th>
            <th className="px-3 py-2 text-right">Monto</th>
            <th className="px-3 py-2 text-left">Observación</th>
            <th className="px-3 py-2 text-left">Banco match</th>
            <th className="px-3 py-2 text-left">Razón / Tipo</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                Cargando…
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                Sin movimientos en este estado.
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onOpen(r.id)}
                className="border-t border-border-soft/40 hover:bg-bg-elevated/40 cursor-pointer table-row-hover"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatDateTime(r.dynatech.occurredAt)}
                </td>
                <td className="px-3 py-2">
                  <div>{r.dynatech.branchExternalName ?? "—"}</div>
                  <div className="text-xs text-text-muted">
                    {r.dynatech.cashierName || r.dynatech.cashierUsername}
                  </div>
                  {r.dynatech.customerRut && (
                    <div className="text-[10px] text-text-muted truncate max-w-[180px]" title={r.dynatech.customerName ?? undefined}>
                      Cliente: {r.dynatech.customerName ?? r.dynatech.customerRut}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                  {formatMoney(Number(r.dynatech.totalAmount))}
                </td>
                <td
                  className="px-3 py-2 max-w-[280px] truncate"
                  title={r.dynatech.observation}
                >
                  {r.dynatech.observation || "—"}
                </td>
                <td className="px-3 py-2">
                  {r.banks.length === 0 ? (
                    <span className="text-text-dim">—</span>
                  ) : r.banks.length === 1 ? (
                    <>
                      <div className="text-xs">
                        {r.banks[0].account.holderName} · {r.banks[0].account.bankName}
                      </div>
                      <div className="text-xs text-text-muted">
                        {formatDate(r.banks[0].postDate)} ·{" "}
                        {r.banks[0].counterpartyName ?? "—"}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs flex items-center gap-1.5">
                        <span className="rounded bg-accent/15 text-accent px-1.5 py-0.5 text-[10px] font-semibold">
                          {r.banks.length} parts
                        </span>
                        <span>{r.banks[0].account.holderName} · {r.banks[0].account.bankName}</span>
                      </div>
                      <div className="text-xs text-text-muted">
                        Suma: {formatMoney(Number(r.banksSum))}
                      </div>
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-text-muted">
                  {r.outOfScopeReason || r.matchType || ""}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function OtherCreditsTable({
  loading,
  data,
}: {
  loading: boolean;
  data: OtherBankCreditsResponse | null;
}) {
  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
          <tr>
            <th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-right">Monto</th>
            <th className="px-3 py-2 text-left">Glosa</th>
            <th className="px-3 py-2 text-left">Contraparte</th>
            <th className="px-3 py-2 text-left">Ext ID</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                Cargando…
              </td>
            </tr>
          )}
          {!loading && data && data.movements.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                Sin abonos sin contraparte.
              </td>
            </tr>
          )}
          {!loading &&
            data &&
            data.movements.map((m) => (
              <tr
                key={m.id}
                className="border-t border-border-soft hover:bg-bg-soft/40"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {formatDate(m.postDate)}
                </td>
                <td className="px-3 py-2">
                  <div className="text-xs">
                    {m.account.holderName} · {m.account.bankName}
                  </div>
                  <div className="text-xs text-text-muted">
                    {m.account.displayNumber ?? m.account.accountNumber}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-success">
                  +{formatMoney(Number(m.amount), m.currency)}
                </td>
                <td
                  className="px-3 py-2 max-w-[300px] truncate"
                  title={m.description}
                >
                  {m.description}
                </td>
                <td className="px-3 py-2">
                  <div>{m.counterpartyName || "—"}</div>
                  {m.counterpartyRut && (
                    <div className="text-xs text-text-muted">
                      {m.counterpartyRut}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-text-muted">
                  {m.externalId || ""}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      {data && data.total > data.movements.length && (
        <div className="px-3 py-2 text-xs text-text-muted border-t border-border-soft">
          Mostrando {data.movements.length} de {data.total} abonos.
        </div>
      )}
    </div>
  );
}
