"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatMoney, formatDate } from "@/lib/format";
import { usePermisos } from "@/lib/use-permisos";

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
    displayNumber?: string | null;
    holderName?: string;
    alias?: string | null;
    /** Rubro contable más usado en conciliados anteriores de esta cuenta.
     *  Lo usamos como default del select "Rubro banco" en el match manual. */
    suggestedRubro?: number | null;
  };
  isLinked: boolean;
  /** Resuelto por otra vía (no por match contra Tesorería): asiento manual
   *  generado o egreso a tercero conciliado. Solo aparece cuando se muestran
   *  todos (con "Solo sin matchear" apagado). */
  resueltoPor?: "asiento" | "egreso" | null;
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
  /** Glosa parseada por src/lib/consolidados/glosa.ts. isMultiPart=true
   *  indica que es "DEP (N) ..." → parte de un depósito agrupado. */
  glosaParsed?: {
    isMultiPart: boolean;
    partNumber: number | null;
  };
  /** Si esta tesorería forma parte de una sugerencia de split inverso
   *  detectada por el backend (otras tesorerías del mismo cliente cuya
   *  suma matchea un BankMovement sin matchear). */
  suggestedSplit?: {
    bankMovementId: string;
    tesoreriaIds: string[];
    totalAmount: string;
  } | null;
}

interface BankMovementWithSuggestion extends BankMovementDTO {
  /** Si esta cartola tiene un candidato a split inverso (varias tesorerías
   *  cuyo monto suma esta cartola), el backend lo señala acá. */
  suggestedSplit?: {
    tesoreriaIds: string[];
    totalAmount: string;
    clienteRut: string;
    banco: string;
  } | null;
}

interface CompareResponse {
  bankMovements: BankMovementWithSuggestion[];
  tesoreriaMovements: TesoreriaCompareDTO[];
  accounts: Array<{
    id: string;
    bankCode: string;
    bankName: string;
    accountNumber: string;
    displayNumber?: string | null;
    holderName?: string;
    alias?: string | null;
  }>;
  bancos: string[];
  range: { since: string; until: string };
}

interface SiblingHint {
  message: string;
  siblings: Array<{
    id: string;
    fecha: string;
    monto: string;
    glosa: string;
    clienteName: string | null;
  }>;
}

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}
function defaultUntil(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CompareView({
  direction = "IN",
}: {
  /** IN  → Comparar Ingresos: cartola IN ↔ Tesorería INGRESO (default).
   *  OUT → Comparar Egresos:  cartola OUT ↔ Tesorería EGRESO (Dynatech). */
  direction?: "IN" | "OUT";
} = {}) {
  // Si se llega aca desde Cartolas (atajo "Conciliar pendientes"), trae el
  // accountId en el query string para pre-filtrar.
  const searchParams = useSearchParams();
  const presetAccountId = searchParams.get("accountId") ?? "";
  // Sin permiso de conciliar, la vista es solo consulta (no aparece la barra
  // de vincular). El backend igual rechaza el manual-link con 403.
  const { can } = usePermisos();
  const puedeConciliar = can("conciliar");

  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Filtros
  const [since, setSince] = useState(defaultSince());
  const [until, setUntil] = useState(defaultUntil());
  const [accountId, setAccountId] = useState(presetAccountId);
  const [banco, setBanco] = useState("");
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  // Oculta IN cuya contraparte es una EntidadInterna (Traspasos internos).
  // Default true: el flujo de match contra Tesorería es para ventas a
  // cliente, no traspasos entre cuentas propias.
  const [hideInternal, setHideInternal] = useState(true);
  const [search, setSearch] = useState("");

  // Selección
  const [selectedBankIds, setSelectedBankIds] = useState<Set<string>>(new Set());
  // Soporta seleccionar 1 o N tesorerías. N>1 habilita el split inverso
  // (1 cartola repartida entre varias tesorerías del mismo cliente).
  const [selectedTesoreriaIds, setSelectedTesoreriaIds] = useState<Set<string>>(
    new Set()
  );
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // "Crear banco manual": definir a mano el movimiento bancario que la cartola
  // no capturó, para cuadrar una Tesorería y que deje de estar estancada.
  const [manualBankOpen, setManualBankOpen] = useState(false);
  // Cuando el backend detecta que la diferencia podría ser otra tesorería
  // sin matchear (warning POSSIBLE_SIBLING), mostramos modal de confirmación.
  const [siblingHint, setSiblingHint] = useState<SiblingHint | null>(null);

  // Ajuste para match con diferencia
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustRubro, setAdjustRubro] = useState<number | null>(null);
  const [adjustNote, setAdjustNote] = useState("");
  const [diffRubros, setDiffRubros] = useState<
    Array<{ rubro: number; name: string }>
  >([]);
  const [bankRubros, setBankRubros] = useState<
    Array<{ rubro: number; name: string }>
  >([]);

  // Override de rubro banco (opcional). Si el operador no lo cambia, el
  // asiento OK usa el rubroBanco que vino de Tesorería. Esto es lo que se
  // ajusta cuando la sucursal tipeó mal el banco al cargar el movimiento.
  const [overrideRubroBanco, setOverrideRubroBanco] = useState<number | null>(
    null
  );

  // Cargar catálogo de rubros una vez. Separamos en dos listas:
  // - diffRubros: para el ajuste (isDifference=true)
  // - bankRubros: para el override (isDifference=false)
  useEffect(() => {
    fetch("/api/rubros")
      .then((r) => r.json())
      .then((d) => {
        const all = (d.rubros ?? []) as Array<{
          rubro: number;
          name: string;
          isDifference?: boolean;
        }>;
        setDiffRubros(
          all
            .filter((r) => r.isDifference)
            .map((r) => ({ rubro: r.rubro, name: r.name }))
        );
        setBankRubros(
          all
            .filter((r) => !r.isDifference)
            .map((r) => ({ rubro: r.rubro, name: r.name }))
        );
      })
      .catch(() => {
        setDiffRubros([]);
        setBankRubros([]);
      });
  }, []);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ since, until });
      if (accountId) params.set("accountId", accountId);
      if (banco) params.set("banco", banco);
      params.set("onlyUnmatched", String(onlyUnmatched));
      params.set("hideInternal", String(hideInternal));
      params.set("direction", direction);
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
  }, [since, until, accountId, banco, onlyUnmatched, hideInternal, direction]);

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

  // Listas de despliegue: los SELECCIONADOS van fijos arriba y se muestran
  // siempre, aunque no matcheen el filtro/búsqueda actual. Así, al limpiar el
  // buscador (o cambiar el filtro) no se pierde de vista lo que ya elegiste.
  const displayBank = useMemo(() => {
    if (!data) return [];
    const sel = data.bankMovements.filter((b) => selectedBankIds.has(b.id));
    const rest = filteredBank.filter((b) => !selectedBankIds.has(b.id));
    return [...sel, ...rest];
  }, [data, filteredBank, selectedBankIds]);

  const displayTesoreria = useMemo(() => {
    if (!data) return [];
    const sel = data.tesoreriaMovements.filter((t) =>
      selectedTesoreriaIds.has(t.id)
    );
    const rest = filteredTesoreria.filter((t) => !selectedTesoreriaIds.has(t.id));
    return [...sel, ...rest];
  }, [data, filteredTesoreria, selectedTesoreriaIds]);

  // Suma de seleccionados para validar match
  const selectedBankSum = useMemo(() => {
    if (!data) return 0n;
    let sum = 0n;
    for (const bm of data.bankMovements) {
      if (selectedBankIds.has(bm.id)) sum += BigInt(bm.amount);
    }
    return sum;
  }, [data, selectedBankIds]);

  const selectedTesorerias = useMemo(() => {
    if (!data) return [] as TesoreriaCompareDTO[];
    return data.tesoreriaMovements.filter((t) => selectedTesoreriaIds.has(t.id));
  }, [data, selectedTesoreriaIds]);

  const selectedTesoreriaSum = useMemo(() => {
    let sum = 0n;
    for (const t of selectedTesorerias) sum += BigInt(t.monto);
    return sum;
  }, [selectedTesorerias]);

  // Single-tesorería compat: cuando hay exactamente una seleccionada, la
  // exponemos como `selectedTesoreria` para el código existente (warning de
  // banco distinto, sugerencia de rubro, etc.).
  const selectedTesoreria = selectedTesorerias.length === 1
    ? selectedTesorerias[0]
    : null;
  const isMultiTesoreria = selectedTesorerias.length > 1;

  // Cartolas actualmente seleccionadas (para warning de banco distinto)
  const selectedBanks = useMemo(() => {
    if (!data) return [] as BankMovementWithSuggestion[];
    return data.bankMovements.filter((bm) => selectedBankIds.has(bm.id));
  }, [data, selectedBankIds]);

  // Rubro sugerido a partir de las cartolas seleccionadas: si todas comparten
  // el mismo suggestedRubro (historial de la cuenta), devolvemos ese. Solo es
  // una PISTA visual — el operador del match manual tiene que elegirlo
  // conscientemente con un click (si fuera automático, ya sería un AUTO_MATCH).
  const suggestedRubroFromBanks = useMemo<number | null>(() => {
    if (selectedBanks.length === 0) return null;
    const rubros = new Set(
      selectedBanks
        .map((b) => b.account.suggestedRubro ?? null)
        .filter((r): r is number => r !== null)
    );
    if (rubros.size === 1) return Array.from(rubros)[0];
    return null;
  }, [selectedBanks]);

  // Al cambiar la selección, resetear el override (NO se auto-elige el sugerido).
  useEffect(() => {
    setOverrideRubroBanco(null);
  }, [selectedBankIds]);

  const suggestedRubroLabel = useMemo<string | null>(() => {
    if (suggestedRubroFromBanks === null) return null;
    const r = bankRubros.find((x) => x.rubro === suggestedRubroFromBanks);
    return r ? `${r.rubro} · ${r.name}` : String(suggestedRubroFromBanks);
  }, [suggestedRubroFromBanks, bankRubros]);

  // Warning: ¿el bankName de las cartolas seleccionadas difiere del banco que
  // dijo Tesorería? Ej. Tesorería dice "Santander ME" y la cartola es "BCI".
  // Si hay mismatch, mostramos un aviso para que el operador elija manualmente
  // el rubro correcto en el select de override.
  const bankMismatch = useMemo<string | null>(() => {
    if (!selectedTesoreria || selectedBanks.length === 0) return null;
    const tBanco = (selectedTesoreria.banco || "").toLowerCase().trim();
    if (!tBanco) return null;
    const bankNames = Array.from(
      new Set(selectedBanks.map((b) => b.account.bankName))
    );
    const matches = bankNames.every((bn) => {
      const lower = bn.toLowerCase();
      return tBanco.includes(lower) || lower.includes(tBanco);
    });
    return matches ? null : bankNames.join(" / ");
  }, [selectedTesoreria, selectedBanks]);

  // Diferencia entre lo seleccionado (banco vs tesorería). Si !== 0n hay desajuste.
  const diff = useMemo(() => {
    if (selectedTesoreriaIds.size === 0) return 0n;
    return selectedBankSum - selectedTesoreriaSum;
  }, [selectedBankSum, selectedTesoreriaSum, selectedTesoreriaIds.size]);
  const hasDiff = diff !== 0n;
  const absDiff = diff < 0n ? -diff : diff;

  // El ajuste por diferencia se permite también en split inverso (N>1): la
  // diferencia se carga al asiento de la tesorería que el backend deja con el
  // faltante. El operador elige el rubro de diferencia igual que en 1:1.
  const adjustmentAllowed = true;

  const canLink =
    selectedTesoreriaIds.size > 0 &&
    selectedBankIds.size > 0 &&
    (!hasDiff || (adjustmentAllowed && adjustOpen && adjustRubro !== null));

  const linkButtonText = (() => {
    if (selectedBankIds.size === 0 || selectedTesoreriaIds.size === 0)
      return "Seleccioná items en ambos lados";
    if (hasDiff && !adjustmentAllowed) {
      return `La suma no coincide (${formatMoney(absDiff)} de diferencia) — no se puede ajustar con varias tesorerías`;
    }
    if (hasDiff && !adjustOpen) {
      return `Matchear con ajuste (${formatMoney(absDiff)} de diferencia)`;
    }
    if (hasDiff && adjustOpen) {
      return adjustRubro !== null
        ? `Vincular con ajuste de ${formatMoney(absDiff)}`
        : "Elegí un rubro de ajuste";
    }
    if (isMultiTesoreria) {
      return `Vincular ${selectedBankIds.size} cartola${selectedBankIds.size > 1 ? "s" : ""} con ${selectedTesoreriaIds.size} tesorerías (split inverso)`;
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

  function toggleTesoreria(id: string) {
    setSelectedTesoreriaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Vincula las selecciones actuales. Si `acknowledgeSiblingWarning` viene
   *  en true, se mandó después de que el operador confirmó un warning
   *  POSSIBLE_SIBLING (la diferencia coincidía con otra tesorería del mismo
   *  cliente). */
  async function linkSelected(acknowledgeSiblingWarning = false) {
    if (!canLink) {
      if (
        selectedTesoreriaIds.size > 0 &&
        selectedBankIds.size > 0 &&
        hasDiff &&
        adjustmentAllowed &&
        !adjustOpen
      ) {
        setAdjustOpen(true);
      }
      return;
    }
    setLinking(true);
    setLinkError(null);
    try {
      const body: Record<string, unknown> = {
        tesoreriaIds: Array.from(selectedTesoreriaIds),
        bankMovementIds: Array.from(selectedBankIds),
      };
      if (hasDiff && adjustmentAllowed && adjustOpen && adjustRubro !== null) {
        body.adjustment = {
          rubro: adjustRubro,
          note: adjustNote.trim() || null,
        };
      }
      if (overrideRubroBanco !== null) {
        body.overrideRubroBanco = overrideRubroBanco;
      }
      if (acknowledgeSiblingWarning) {
        body.acknowledgeSiblingWarning = true;
      }
      const res = await fetch("/api/consolidados/manual-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        // Warning soft: backend detectó posible sibling. Mostramos modal y
        // dejamos al operador confirmar o cancelar.
        if (res.status === 409 && e.warning === "POSSIBLE_SIBLING") {
          setSiblingHint({ message: e.message, siblings: e.siblings ?? [] });
          return;
        }
        setLinkError(e.error || "Error al vincular");
        return;
      }
      setSelectedBankIds(new Set());
      setSelectedTesoreriaIds(new Set());
      setAdjustOpen(false);
      setAdjustRubro(null);
      setAdjustNote("");
      setOverrideRubroBanco(null);
      setSiblingHint(null);
      await load();
    } finally {
      setLinking(false);
    }
  }

  /** Cuando hay un sibling sugerido, este atajo lo incluye en la selección
   *  para que el operador cierre el match directamente como split inverso
   *  (sin ajuste). */
  function includeSiblingsInSelection() {
    if (!siblingHint) return;
    setSelectedTesoreriaIds((prev) => {
      const next = new Set(prev);
      for (const s of siblingHint.siblings) next.add(s.id);
      return next;
    });
    setSiblingHint(null);
    setAdjustOpen(false);
    setAdjustRubro(null);
    setAdjustNote("");
  }

  // Resetear ajuste cuando cambie la selección o se vuelva multi-tesorería
  // (donde el ajuste no está soportado).
  useEffect(() => {
    if (!hasDiff || !adjustmentAllowed) {
      setAdjustOpen(false);
      setAdjustRubro(null);
      setAdjustNote("");
    }
  }, [hasDiff, adjustmentAllowed]);

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
              .map((a) => {
                const label =
                  a.holderName
                    ? `${a.bankName} ${a.holderName} · ${a.displayNumber || a.accountNumber}`
                    : `${a.bankName} · ${a.displayNumber || a.accountNumber}`;
                return (
                  <option key={a.id} value={a.id}>
                    {label}
                    {a.alias && ` (${a.alias})`}
                  </option>
                );
              })}
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
        <label
          className="flex items-center gap-2 text-sm whitespace-nowrap"
          title={`Oculta los ${direction} cuya contraparte es una entidad interna (ya se ven en Traspasos internos).`}
        >
          <input
            type="checkbox"
            checked={hideInternal}
            onChange={(e) => setHideInternal(e.target.checked)}
          />
          Ocultar internos
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
      {puedeConciliar && (selectedBankIds.size > 0 || selectedTesoreriaIds.size > 0) && (
        <div className="sticky top-16 z-20 rounded-md border border-brand/40 bg-brand/5 backdrop-blur p-3 shadow-soft flex items-center justify-between gap-4 flex-wrap">
          <div className="text-sm">
            {selectedTesoreriaIds.size > 0 ? (
              <span>
                <span className="text-text-muted">Tesorería:</span>{" "}
                <strong>{formatMoney(selectedTesoreriaSum)}</strong>{" "}
                {selectedTesoreriaIds.size === 1
                  ? `· ${selectedTesorerias[0].clienteName ?? "—"}`
                  : `· ${selectedTesoreriaIds.size} movimientos`}
              </span>
            ) : (
              <span className="text-text-muted">Seleccioná movimientos de Tesorería →</span>
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
                setSelectedTesoreriaIds(new Set());
                setLinkError(null);
                setAdjustOpen(false);
                setSiblingHint(null);
              }}
              className="btn-ghost text-xs"
            >
              Limpiar selección
            </button>
            {/* Tesorería sola (sin cartola que la cuadre): definir el banco a
                mano. La cartola no capturó ese movimiento pero existe. */}
            {selectedTesoreriaIds.size === 1 && selectedBankIds.size === 0 && (
              <button
                onClick={() => setManualBankOpen(true)}
                className="btn-ghost text-sm border border-brand/40 text-brand"
                title="La cartola no tiene este movimiento: definí el banco a mano para cuadrar esta Tesorería"
              >
                Crear banco manual
              </button>
            )}
            {/* Si hay diferencia y el panel no está abierto, el botón abre el
                panel de ajuste en lugar de intentar vincular. */}
            <button
              onClick={() => {
                if (hasDiff && adjustmentAllowed && !adjustOpen) {
                  setAdjustOpen(true);
                  return;
                }
                void linkSelected();
              }}
              disabled={
                (!canLink && !(hasDiff && adjustmentAllowed && !adjustOpen)) ||
                linking ||
                selectedTesoreriaIds.size === 0 ||
                selectedBankIds.size === 0
              }
              className="btn-primary text-sm disabled:opacity-50"
            >
              {linking ? "Vinculando..." : linkButtonText}
            </button>
          </div>
          {linkError && (
            <div className="w-full text-sm text-rose-700">{linkError}</div>
          )}

          {/* Aviso de split inverso (multi-tesorería) */}
          {isMultiTesoreria && (
            <div className="w-full text-xs rounded-md border border-brand/30 bg-brand/10 text-brand px-3 py-2">
              <strong>Split inverso:</strong> vas a vincular {selectedTesoreriaIds.size} tesorerías con {selectedBankIds.size} cartola{selectedBankIds.size > 1 ? "s" : ""}. El monto de cada cartola se repartirá automáticamente entre las tesorerías por orden de fecha.
            </div>
          )}

          {/* Override de rubro banco (solo si hay selección completa) */}
          {selectedTesoreria && selectedBankIds.size > 0 && (
            <div className="w-full mt-2 flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[260px]">
                <label className="label">Rubro banco (asiento OK)</label>
                <select
                  className="input"
                  value={overrideRubroBanco ?? ""}
                  onChange={(e) =>
                    setOverrideRubroBanco(
                      e.target.value ? Number(e.target.value) : null
                    )
                  }
                >
                  <option value="">
                    — Usar el de Tesorería (
                    {selectedTesoreria.banco || "sin banco"}) —
                  </option>
                  {bankRubros.map((r) => (
                    <option key={r.rubro} value={r.rubro}>
                      {r.rubro} · {r.name}
                    </option>
                  ))}
                </select>
                {/* Pista de rubro sugerido: NO se selecciona solo, el operador
                    tiene que hacer click conscientemente. */}
                {suggestedRubroLabel !== null &&
                  overrideRubroBanco !== suggestedRubroFromBanks && (
                    <div className="mt-2 flex items-center justify-between gap-3 flex-wrap rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
                      <span className="text-sm text-amber-900">
                        <span className="mr-1 text-base">💡</span>
                        Según el historial de esta cuenta, el rubro suele ser{" "}
                        <span className="font-mono font-bold text-amber-950">
                          {suggestedRubroLabel}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setOverrideRubroBanco(suggestedRubroFromBanks)
                        }
                        className="shrink-0 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-600"
                      >
                        Usar este
                      </button>
                    </div>
                  )}
              </div>
              {bankMismatch && (
                <div className="flex-1 min-w-[260px] text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2">
                  <strong>⚠ Banco distinto:</strong> Tesorería dice{" "}
                  <span className="font-mono">{selectedTesoreria.banco}</span>{" "}
                  pero la cartola es{" "}
                  <span className="font-mono">{bankMismatch}</span>. Elegí el
                  rubro correcto arriba para que el asiento OK quede bien.
                </div>
              )}
            </div>
          )}

          {/* Panel de ajuste: aparece cuando hay diferencia y el operador
              confirma que quiere matchear con desajuste. */}
          {hasDiff && adjustOpen && (
            <div className="w-full mt-2 rounded-md border border-amber-300 bg-amber-50/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm">
                  <strong>Diferencia detectada:</strong>{" "}
                  <span className="font-mono">{formatMoney(absDiff)}</span>{" "}
                  <span className="text-text-muted">
                    ({diff > 0n ? "banco > tesorería" : "banco < tesorería"})
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAdjustOpen(false);
                    setAdjustRubro(null);
                    setAdjustNote("");
                  }}
                  className="btn-ghost text-xs"
                >
                  Cancelar ajuste
                </button>
              </div>
              <div className="flex flex-wrap gap-2 items-end">
                <div className="flex-1 min-w-[200px]">
                  <label className="label">Rubro para la diferencia</label>
                  <select
                    className="input"
                    value={adjustRubro ?? ""}
                    onChange={(e) =>
                      setAdjustRubro(
                        e.target.value ? Number(e.target.value) : null
                      )
                    }
                  >
                    <option value="">— Elegí un rubro —</option>
                    {diffRubros.map((r) => (
                      <option key={r.rubro} value={r.rubro}>
                        {r.rubro} · {r.name}
                      </option>
                    ))}
                  </select>
                  {diffRubros.length === 0 && (
                    <p className="text-xs text-warn mt-1">
                      No hay rubros marcados como "Usar para diferencias".
                      Configuralos en Configuración → Rubros.
                    </p>
                  )}
                </div>
                <div className="flex-1 min-w-[240px]">
                  <label className="label">Glosa (opcional)</label>
                  <input
                    type="text"
                    className="input"
                    value={adjustNote}
                    onChange={(e) => setAdjustNote(e.target.value)}
                    placeholder="ej: cliente transfirió monto redondeado"
                    maxLength={500}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal de sibling: el backend detectó que la diferencia podría ser
          otra tesorería sin matchear del mismo cliente. Damos al operador
          dos salidas: incluir esas tesorerías (split inverso) o confirmar
          el ajuste igual. */}
      {siblingHint && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSiblingHint(null)}
        >
          <div
            className="bg-bg rounded-md border border-amber-300 shadow-soft max-w-xl w-full p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className="text-amber-600 text-lg">⚠</span>
              <h3 className="font-bold text-text">Posible depósito agrupado</h3>
            </div>
            <p className="text-sm text-text">{siblingHint.message}</p>
            <div className="rounded-md border border-border-soft bg-zinc-50 divide-y divide-border-soft text-sm">
              {siblingHint.siblings.map((s) => (
                <div key={s.id} className="p-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-text-muted">
                      {formatDate(s.fecha)} · {s.clienteName ?? "—"}
                    </div>
                    <div className="text-xs text-text-muted truncate">{s.glosa}</div>
                  </div>
                  <div className="font-mono font-bold whitespace-nowrap">
                    {formatMoney(BigInt(s.monto))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSiblingHint(null)}
                className="btn-ghost text-sm"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void linkSelected(true)}
                className="btn-ghost text-sm border border-amber-300 text-amber-800"
              >
                Es una diferencia real, confirmar
              </button>
              <button
                type="button"
                onClick={includeSiblingsInSelection}
                className="btn-primary text-sm"
              >
                Incluir{" "}
                {siblingHint.siblings.length === 1
                  ? "esa tesorería"
                  : "esas tesorerías"}
              </button>
            </div>
          </div>
        </div>
      )}

      {manualBankOpen && selectedTesorerias.length === 1 && (
        <ManualBankModal
          tesoreria={selectedTesorerias[0]}
          accounts={data?.accounts ?? []}
          onClose={() => setManualBankOpen(false)}
          onCreated={async () => {
            setManualBankOpen(false);
            setSelectedTesoreriaIds(new Set());
            setSelectedBankIds(new Set());
            await load();
          }}
        />
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
            {!loading && displayBank.length === 0 && (
              <div className="text-center py-8 text-sm text-text-muted">
                Sin cartolas en este filtro.
              </div>
            )}
            {displayBank.map((bm) => (
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
            {!loading && displayTesoreria.length === 0 && (
              <div className="text-center py-8 text-sm text-text-muted">
                Sin Tesorería en este filtro.
              </div>
            )}
            {displayTesoreria.map((t) => (
              <TesoreriaCard
                key={t.id}
                t={t}
                selected={selectedTesoreriaIds.has(t.id)}
                highlightAmount={
                  selectedBankIds.size > 0 && selectedBankSum === BigInt(t.monto)
                }
                onClick={() => toggleTesoreria(t.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ========================= Banco manual (modal) ========================= */

/**
 * Modal para definir a mano el movimiento bancario que la cartola no capturó y
 * conciliar la Tesorería con él. El monto del banco se iguala a la Tesorería
 * (así el asiento OK cuadra). Queda `manual=true` (excluido de saldos/cartolas).
 */
function ManualBankModal({
  tesoreria,
  accounts,
  onClose,
  onCreated,
}: {
  tesoreria: TesoreriaCompareDTO;
  accounts: CompareResponse["accounts"];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const defaultAccount = useMemo(() => {
    const banco = (tesoreria.banco ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const hit = banco
      ? accounts.find((a) =>
          `${a.bankName} ${a.holderName ?? ""}`.toLowerCase().includes(banco),
        )
      : undefined;
    return hit?.id ?? accounts[0]?.id ?? "";
  }, [accounts, tesoreria.banco]);

  const [accountId, setAccountId] = useState(defaultAccount);
  const [postDate, setPostDate] = useState(tesoreria.fecha.slice(0, 10));
  const [glosa, setGlosa] = useState(
    tesoreria.glosa || tesoreria.clienteName || "Movimiento manual",
  );
  const [nota, setNota] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const monto = BigInt(tesoreria.monto);

  async function submit() {
    if (!accountId) {
      setErr("Elegí una cuenta");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/consolidados/manual-bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tesoreriaId: tesoreria.id,
          accountId,
          postDate,
          glosa: glosa.trim(),
          nota: nota.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error || "Error al crear el movimiento manual");
        return;
      }
      await onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg rounded-md border border-brand/40 shadow-soft max-w-md w-full p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-text">Crear movimiento bancario manual</h3>
        <p className="text-xs text-text-muted">
          Para cuadrar la Tesorería de{" "}
          <strong>{tesoreria.clienteName ?? "—"}</strong> ({formatMoney(monto)}) que
          la cartola no capturó. El monto del banco se iguala a la Tesorería. Queda
          marcado como <strong>manual</strong> y no suma a los saldos.
        </p>
        <div>
          <label className="label">Cuenta bancaria</label>
          <select
            className="input"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">— Elegí una cuenta —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.holderName ?? a.bankName} · {a.displayNumber || a.accountNumber} (
                {a.bankName})
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="label">Fecha</label>
            <input
              type="date"
              className="input"
              value={postDate}
              onChange={(e) => setPostDate(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className="label">Monto (= Tesorería)</label>
            <input className="input font-mono" value={formatMoney(monto)} disabled readOnly />
          </div>
        </div>
        <div>
          <label className="label">Glosa</label>
          <input
            className="input"
            value={glosa}
            onChange={(e) => setGlosa(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Nota (opcional)</label>
          <textarea
            className="input"
            rows={2}
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            placeholder="Por qué se define a mano (queda registrado)"
          />
        </div>
        {err && <div className="text-sm text-rose-700">{err}</div>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !accountId}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {saving ? "Creando…" : "Crear y conciliar"}
          </button>
        </div>
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
  bm: BankMovementWithSuggestion;
  selected: boolean;
  highlightAmount: boolean;
  onClick: () => void;
}) {
  // Resuelto = vinculado al motor O por otra vía (asiento manual / egreso).
  const resuelto = bm.isLinked || !!bm.resueltoPor;
  // Color de la barra lateral según estado
  //   verde   = vinculado/resuelto (conciliado)
  //   ámbar   = sin matchear (pendiente de acción)
  //   brand   = seleccionado
  //   esmeralda = highlight de match potencial (mismo monto que la T° seleccionada)
  const stripCls = selected
    ? "bg-brand"
    : highlightAmount
    ? "bg-emerald-500"
    : resuelto
    ? "bg-success/70"
    : "bg-warn/70";
  const cardBgCls = selected
    ? "border-brand bg-brand/10 shadow-soft"
    : highlightAmount
    ? "border-emerald-400 bg-emerald-50/50 hover:bg-emerald-50"
    : resuelto
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
            {bm.account.holderName && (
              <span className="text-xs font-semibold text-brand/80 uppercase tracking-wide">
                {bm.account.holderName}
              </span>
            )}
            <span className="text-xs text-text-muted font-mono">
              {bm.account.displayNumber || bm.account.accountNumber}
            </span>
            {bm.isLinked ? (
              <span className="badge border-success/40 bg-success/10 text-success">
                ✓ vinculado
              </span>
            ) : bm.resueltoPor === "asiento" ? (
              <span className="badge border-success/40 bg-success/10 text-success">
                📝 asiento generado
              </span>
            ) : bm.resueltoPor === "egreso" ? (
              <span className="badge border-success/40 bg-success/10 text-success">
                ✓ egreso a tercero
              </span>
            ) : (
              <span className="badge border-warn/40 bg-warn/10 text-warn">
                ⚠ sin matchear
              </span>
            )}
            {bm.suggestedSplit && !bm.isLinked && (
              <span className="badge border-violet-400/50 bg-violet-50 text-violet-700">
                💡 split posible ({bm.suggestedSplit.tesoreriaIds.length} TM)
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
      {bm.suggestedSplit && !bm.isLinked && (
        <div className="mt-2 text-[11px] rounded border border-violet-200 bg-violet-50/60 text-violet-800 px-2 py-1">
          Posible depósito agrupado: {bm.suggestedSplit.tesoreriaIds.length} tesorerías del mismo cliente suman este monto. Seleccionalas a la derecha para cerrar el match.
        </div>
      )}
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
            {t.glosaParsed?.isMultiPart && (
              <span className="badge border-violet-400/50 bg-violet-50 text-violet-700">
                Parte {t.glosaParsed.partNumber ?? "?"}
              </span>
            )}
            {t.suggestedSplit && !t.glosaParsed?.isMultiPart && (
              <span className="badge border-violet-400/50 bg-violet-50 text-violet-700">
                💡 split posible
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
      {(t.glosaParsed?.isMultiPart || t.suggestedSplit) && (
        <div className="mt-2 text-[11px] rounded border border-violet-200 bg-violet-50/60 text-violet-800 px-2 py-1">
          {t.glosaParsed?.isMultiPart
            ? "Glosa marcada como parte de un depósito agrupado. Seleccionala junto a las otras partes y la cartola correspondiente."
            : "Otras tesorerías del mismo cliente podrían formar un depósito agrupado contra una cartola sin matchear."}
        </div>
      )}
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
