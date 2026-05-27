"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney, formatDate } from "@/lib/format";

interface BankMovementDTO {
  id: string;
  postDate: string;
  amount: string;
  description: string;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  account: {
    id: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    alias?: string | null;
  };
  isLinked: boolean;
}

interface TesoreriaCompareDTO {
  id: string;
  externalId: string;
  fecha: string;
  monto: string;
  glosa: string;
  banco: string | null;
  clienteName: string | null;
  clienteRut: string | null;
  sucursalName: string | null;
  esExcepcion: boolean;
  consolidado: {
    id: string;
    status: string;
    score: number | null;
    matchType: string | null;
  } | null;
}

interface CompareResponse {
  bankMovements: BankMovementDTO[];
  tesoreriaMovements: TesoreriaCompareDTO[];
  accounts: Array<{
    id: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    alias?: string | null;
  }>;
  bancos: string[];
  range: { since: string; until: string };
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}
function defaultUntil(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CompareView() {
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Filtros
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(defaultUntil());
  const [accountId, setAccountId] = useState("");
  const [banco, setBanco] = useState("");
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const [search, setSearch] = useState("");

  // Selección
  const [selectedBankIds, setSelectedBankIds] = useState<Set<string>>(new Set());
  const [selectedTesoreriaId, setSelectedTesoreriaId] = useState<string | null>(
    null
  );
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ since, until });
      if (accountId) params.set("accountId", accountId);
      if (banco) params.set("banco", banco);
      params.set("onlyUnmatched", String(onlyUnmatched));
      const res = await fetch(`/api/consolidados/compare?${params}`);
      if (res.ok) {
        setData(await res.json());
      } else {
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since, until, accountId, banco, onlyUnmatched]);

  // Filtros client-side por search
  const filteredBank = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.bankMovements;
    const q = search.toLowerCase();
    return data.bankMovements.filter(
      (bm) =>
        bm.description.toLowerCase().includes(q) ||
        bm.counterpartyName?.toLowerCase().includes(q) ||
        bm.counterpartyRut?.toLowerCase().includes(q) ||
        bm.amount.includes(q)
    );
  }, [data, search]);

  const filteredTesoreria = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.tesoreriaMovements;
    const q = search.toLowerCase();
    return data.tesoreriaMovements.filter(
      (t) =>
        t.glosa.toLowerCase().includes(q) ||
        t.clienteName?.toLowerCase().includes(q) ||
        t.clienteRut?.toLowerCase().includes(q) ||
        t.monto.includes(q) ||
        t.banco?.toLowerCase().includes(q)
    );
  }, [data, search]);

  // Suma de seleccionados para validar match
  const selectedBankSum = useMemo(() => {
    if (!data) return 0n;
    let sum = 0n;
    for (const bm of data.bankMovements) {
      if (selectedBankIds.has(bm.id)) sum += BigInt(bm.amount);
    }
    return sum;
  }, [data, selectedBankIds]);

  const selectedTesoreria = useMemo(() => {
    if (!data || !selectedTesoreriaId) return null;
    return data.tesoreriaMovements.find((t) => t.id === selectedTesoreriaId) ?? null;
  }, [data, selectedTesoreriaId]);

  const canLink =
    selectedTesoreria !== null &&
    selectedBankIds.size > 0 &&
    selectedBankSum === BigInt(selectedTesoreria.monto);

  const linkButtonText = (() => {
    if (selectedBankIds.size === 0 || !selectedTesoreria)
      return "Seleccioná items en ambos lados";
    if (selectedBankSum !== BigInt(selectedTesoreria.monto)) {
      const diff = BigInt(selectedTesoreria.monto) - selectedBankSum;
      return `Diferencia: ${formatMoney(diff)} (no calza)`;
    }
    return `Vincular ${selectedBankIds.size} cartola${selectedBankIds.size > 1 ? "s" : ""} con esta Tesorería`;
  })();

  function toggleBank(id: string) {
    setSelectedBankIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function linkSelected() {
    if (!canLink || !selectedTesoreria) return;
    setLinking(true);
    setLinkError(null);
    try {
      const res = await fetch("/api/consolidados/manual-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tesoreriaId: selectedTesoreria.id,
          bankMovementIds: Array.from(selectedBankIds),
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setLinkError(e.error || "Error al vincular");
        return;
      }
      setSelectedBankIds(new Set());
      setSelectedTesoreriaId(null);
      await load();
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Desde</label>
          <input
            type="date"
            className="input"
            value={since}
            onChange={(e) => setSince(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Hasta</label>
          <input
            type="date"
            className="input"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Cuenta bancaria</label>
          <select
            className="input"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">Todas</option>
            {data?.accounts
              .filter((a) => !a.accountNumber.startsWith("_UNASSIGNED_"))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bankName} · {a.accountNumber}
                  {a.alias && ` (${a.alias})`}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label className="label">Banco (Tesorería)</label>
          <select
            className="input"
            value={banco}
            onChange={(e) => setBanco(e.target.value)}
          >
            <option value="">Todos</option>
            {data?.bancos.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="label">Buscar (nombre/RUT/glosa/monto)</label>
          <input
            type="text"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ej: VENEGAS / 76123456-7 / 1500000"
          />
        </div>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input
            type="checkbox"
            checked={onlyUnmatched}
            onChange={(e) => setOnlyUnmatched(e.target.checked)}
          />
          Solo sin matchear
        </label>
      </div>

      {/* Barra de acción flotante */}
      {(selectedBankIds.size > 0 || selectedTesoreriaId) && (
        <div className="sticky top-16 z-20 rounded-md border border-brand/40 bg-brand/5 backdrop-blur p-3 shadow-soft flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm">
            {selectedTesoreria ? (
              <span>
                <span className="text-text-muted">Tesorería:</span>{" "}
                <strong>{formatMoney(BigInt(selectedTesoreria.monto))}</strong>{" "}
                · {selectedTesoreria.clienteName ?? "—"}
              </span>
            ) : (
              <span className="text-text-muted">Seleccioná un movimiento de Tesorería →</span>
            )}
            <span className="mx-3 text-text-dim">|</span>
            {selectedBankIds.size > 0 ? (
              <span>
                <span className="text-text-muted">Bancos:</span>{" "}
                <strong>{formatMoney(selectedBankSum)}</strong>{" "}
                · {selectedBankIds.size} item{selectedBankIds.size > 1 ? "s" : ""}
              </span>
            ) : (
              <span className="text-text-muted">← seleccioná cartolas</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSelectedBankIds(new Set());
                setSelectedTesoreriaId(null);
                setLinkError(null);
              }}
              className="btn-ghost text-xs"
            >
              Limpiar selección
            </button>
            <button
              onClick={linkSelected}
              disabled={!canLink || linking}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {linking ? "Vinculando..." : linkButtonText}
            </button>
          </div>
          {linkError && (
            <div className="w-full text-sm text-rose-700">{linkError}</div>
          )}
        </div>
      )}

      {/* Dos columnas */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* IZQUIERDA: Cartolas bancarias */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <h3 className="text-sm font-bold text-brand">
              Movimientos bancarios{" "}
              <span className="text-xs text-text-muted font-normal">
                ({filteredBank.length})
              </span>
            </h3>
          </div>
          <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
            {loading && (
              <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
            )}
            {!loading && filteredBank.length === 0 && (
              <div className="text-center py-8 text-sm text-text-muted">
                Sin cartolas en este filtro.
              </div>
            )}
            {filteredBank.map((bm) => (
              <BankCard
                key={bm.id}
                bm={bm}
                selected={selectedBankIds.has(bm.id)}
                highlightAmount={
                  selectedTesoreria ? selectedTesoreria.monto === bm.amount : false
                }
                onClick={() => toggleBank(bm.id)}
              />
            ))}
          </div>
        </section>

        {/* DERECHA: Tesoreria */}
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <h3 className="text-sm font-bold text-brand">
              Movimientos Tesorería{" "}
              <span className="text-xs text-text-muted font-normal">
                ({filteredTesoreria.length})
              </span>
            </h3>
          </div>
          <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
            {loading && (
              <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
            )}
            {!loading && filteredTesoreria.length === 0 && (
              <div className="text-center py-8 text-sm text-text-muted">
                Sin Tesorería en este filtro.
              </div>
            )}
            {filteredTesoreria.map((t) => (
              <TesoreriaCard
                key={t.id}
                t={t}
                selected={selectedTesoreriaId === t.id}
                highlightAmount={
                  selectedBankIds.size > 0 && selectedBankSum === BigInt(t.monto)
                }
                onClick={() =>
                  setSelectedTesoreriaId((cur) => (cur === t.id ? null : t.id))
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ============================== Cards ============================== */

function BankCard({
  bm,
  selected,
  highlightAmount,
  onClick,
}: {
  bm: BankMovementDTO;
  selected: boolean;
  highlightAmount: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md border p-3 text-sm transition-all ${
        selected
          ? "border-brand bg-brand/10 shadow-soft"
          : highlightAmount
          ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
          : bm.isLinked
          ? "border-border-soft bg-zinc-50 opacity-70 hover:opacity-100"
          : "border-border-soft bg-white hover:bg-bg-soft"
      }`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{bm.account.bankName}</span>
            <span className="text-xs text-text-muted">
              {bm.account.accountNumber}
            </span>
            {bm.isLinked && (
              <span className="badge border-emerald-300 bg-emerald-50 text-emerald-700">
                vinculado
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {formatDate(bm.postDate)}
          </div>
        </div>
        <div className="text-right">
          <div
            className={`font-mono font-bold whitespace-nowrap ${highlightAmount ? "text-emerald-700" : ""}`}
          >
            {formatMoney(BigInt(bm.amount))}
          </div>
        </div>
      </div>
      {bm.counterpartyName && (
        <div className="mt-1 text-xs">
          <span className="font-semibold">De:</span> {bm.counterpartyName}
          {bm.counterpartyRut && (
            <span className="text-text-muted"> · {bm.counterpartyRut}</span>
          )}
        </div>
      )}
      <div className="mt-1 text-xs text-text-muted break-words line-clamp-2">
        {bm.description}
      </div>
    </button>
  );
}

function TesoreriaCard({
  t,
  selected,
  highlightAmount,
  onClick,
}: {
  t: TesoreriaCompareDTO;
  selected: boolean;
  highlightAmount: boolean;
  onClick: () => void;
}) {
  const isUnmatched =
    !t.consolidado ||
    ["NO_MATCH", "REVIEW", "OUT_OF_SCOPE"].includes(t.consolidado.status);
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-md border p-3 text-sm transition-all ${
        selected
          ? "border-brand bg-brand/10 shadow-soft"
          : highlightAmount
          ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
          : !isUnmatched
          ? "border-border-soft bg-zinc-50 opacity-70 hover:opacity-100"
          : "border-border-soft bg-white hover:bg-bg-soft"
      }`}
    >
      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{t.banco ?? "—"}</span>
            {t.sucursalName && (
              <span className="text-xs text-text-muted">{t.sucursalName}</span>
            )}
            {t.esExcepcion && (
              <span className="badge border-warn/40 bg-warn/10 text-warn">EXC</span>
            )}
            {t.consolidado?.status && (
              <span className="text-xs text-text-muted font-mono">
                {t.consolidado.status}
              </span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {formatDate(t.fecha)}
          </div>
        </div>
        <div className="text-right">
          <div
            className={`font-mono font-bold whitespace-nowrap ${highlightAmount ? "text-emerald-700" : ""}`}
          >
            {formatMoney(BigInt(t.monto))}
          </div>
        </div>
      </div>
      {t.clienteName && (
        <div className="mt-1 text-xs">
          <span className="font-semibold">Cliente:</span> {t.clienteName}
          {t.clienteRut && t.clienteRut !== "55555555-5" && (
            <span className="text-text-muted"> · {t.clienteRut}</span>
          )}
        </div>
      )}
      <div className="mt-1 text-xs text-text-muted break-words line-clamp-2">
        {t.glosa}
      </div>
    </button>
  );
}
