"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
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
  // Si se llega aca desde Cartolas (atajo "Conciliar pendientes"), trae el
  // accountId en el query string para pre-filtrar.
  const searchParams = useSearchParams();
  const presetAccountId = searchParams.get("accountId") ?? "";

  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Filtros
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(defaultUntil());
  const [accountId, setAccountId] = useState(presetAccountId);
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

      {/* Leyenda de colores (oculta en móvil) */}
      <div className="hidden md:flex items-center gap-3 text-[11px] text-text-muted px-1">
        <span className="font-semibold uppercase tracking-wider">Leyenda:</span>
        <LegendDot color="bg-success/70" label="Conciliado" />
        <LegendDot color="bg-amber-400" label="Sugerido / Excepción" />
        <LegendDot color="bg-orange-400" label="Revisar" />
        <LegendDot color="bg-warn/70" label="Sin matchear" />
        <LegendDot color="bg-rose-400" label="Fuera de scope" />
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
  // Color de la barra lateral según estado
  //   verde   = vinculado (conciliado)
  //   ámbar   = sin matchear (pendiente de acción)
  //   brand   = seleccionado
  //   esmeralda = highlight de match potencial (mismo monto que la T° seleccionada)
  const stripCls = selected
    ? "bg-brand"
    : highlightAmount
    ? "bg-emerald-500"
    : bm.isLinked
    ? "bg-success/70"
    : "bg-warn/70";
  const cardBgCls = selected
    ? "border-brand bg-brand/10 shadow-soft"
    : highlightAmount
    ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
    : bm.isLinked
    ? "border-border-soft bg-zinc-50 opacity-70 hover:opacity-100"
    : "border-warn/30 bg-warn/[0.04] hover:bg-warn/[0.07]";

  return (
    <button
      onClick={onClick}
      className={`relative w-full text-left rounded-md border p-3 pl-4 text-sm transition-all overflow-hidden ${cardBgCls}`}
    >
      {/* Barra lateral de estado (3px) */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripCls}`}
        aria-hidden
      />

      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{bm.account.bankName}</span>
            <span className="text-xs text-text-muted">{bm.account.accountNumber}</span>
            {bm.isLinked ? (
              <span className="badge border-success/40 bg-success/10 text-success">
                ✓ vinculado
              </span>
            ) : (
              <span className="badge border-warn/40 bg-warn/10 text-warn">
                ⚠ sin matchear
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
  const status = t.consolidado?.status ?? "UNPROCESSED";
  const visualState = getTesoreriaVisualState(status, t.esExcepcion);

  const stripCls = selected
    ? "bg-brand"
    : highlightAmount
    ? "bg-emerald-500"
    : visualState.stripCls;

  const cardBgCls = selected
    ? "border-brand bg-brand/10 shadow-soft"
    : highlightAmount
    ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
    : visualState.cardBgCls;

  return (
    <button
      onClick={onClick}
      className={`relative w-full text-left rounded-md border p-3 pl-4 text-sm transition-all overflow-hidden ${cardBgCls}`}
    >
      {/* Barra lateral de estado */}
      <span
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripCls}`}
        aria-hidden
      />

      <div className="flex justify-between items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{t.banco ?? "—"}</span>
            {t.sucursalName && (
              <span className="text-xs text-text-muted">{t.sucursalName}</span>
            )}
            <span className={`badge ${visualState.badgeCls}`}>
              {visualState.label}
            </span>
            {t.esExcepcion && (
              <span className="badge border-amber-400/50 bg-amber-50 text-amber-700">
                EXC
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

/* =============================== Visual state =============================== */

interface VisualState {
  label: string;
  stripCls: string;
  cardBgCls: string;
  badgeCls: string;
}

function getTesoreriaVisualState(
  status: string,
  esExcepcion: boolean
): VisualState {
  // Excepción API tiene prioridad visual (es un caso especial sin importar status)
  if (esExcepcion && (status === "REVIEW" || status === "UNPROCESSED")) {
    return {
      label: "EXCEPCIÓN",
      stripCls: "bg-amber-400",
      cardBgCls: "border-amber-300 bg-amber-50/40 hover:bg-amber-50/70",
      badgeCls: "border-amber-400/50 bg-amber-50 text-amber-700",
    };
  }

  switch (status) {
    case "AUTO_MATCHED":
    case "MANUAL":
      return {
        label: status === "MANUAL" ? "Manual" : "Conciliado",
        stripCls: "bg-success/70",
        cardBgCls: "border-border-soft bg-zinc-50 opacity-70 hover:opacity-100",
        badgeCls: "border-success/40 bg-success/10 text-success",
      };
    case "SUGGESTED":
      return {
        label: "Sugerido",
        stripCls: "bg-amber-400",
        cardBgCls: "border-amber-300 bg-amber-50/40 hover:bg-amber-50/70",
        badgeCls: "border-amber-400/50 bg-amber-50 text-amber-700",
      };
    case "REVIEW":
      return {
        label: "Revisar",
        stripCls: "bg-orange-400",
        cardBgCls: "border-orange-300 bg-orange-50/40 hover:bg-orange-50/70",
        badgeCls: "border-orange-400/50 bg-orange-50 text-orange-700",
      };
    case "NO_MATCH":
      return {
        label: "Sin matchear",
        stripCls: "bg-warn/70",
        cardBgCls: "border-warn/30 bg-warn/[0.04] hover:bg-warn/[0.07]",
        badgeCls: "border-warn/40 bg-warn/10 text-warn",
      };
    case "OUT_OF_SCOPE":
      return {
        label: "Fuera de scope",
        stripCls: "bg-rose-400",
        cardBgCls: "border-rose-300 bg-rose-50/30 hover:bg-rose-50/60",
        badgeCls: "border-rose-400/50 bg-rose-50 text-rose-700",
      };
    default:
      return {
        label: "Sin procesar",
        stripCls: "bg-sky-400",
        cardBgCls: "border-sky-300 bg-sky-50/30 hover:bg-sky-50/60",
        badgeCls: "border-sky-400/50 bg-sky-50 text-sky-700",
      };
  }
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-1 h-3 rounded-sm ${color}`} />
      {label}
    </span>
  );
}
