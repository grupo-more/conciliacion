"use client";

/**
 * Badge de estado de conciliacion de una salida bancaria (OUT) contra su
 * egreso de Dynatech. `conciliacion` viene de las rutas de egresos
 * internos/terceros: null = la salida todavia no tiene Consolidado vinculado.
 */
export interface ConciliacionInfo {
  status: string;
  matchType: string | null;
  tesoreriaExternalId: string;
}

const LABELS: Record<string, { label: string; cls: string }> = {
  AUTO_MATCHED: {
    label: "Conciliado auto",
    cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  MANUAL: {
    label: "Conciliado manual",
    cls: "bg-emerald-100 text-emerald-800 border-emerald-200",
  },
  SUGGESTED: {
    label: "Sugerido",
    cls: "bg-amber-100 text-amber-800 border-amber-200",
  },
  REVIEW: {
    label: "Revisar",
    cls: "bg-amber-100 text-amber-800 border-amber-200",
  },
  NO_MATCH: {
    label: "Sin match",
    cls: "bg-rose-100 text-rose-800 border-rose-200",
  },
  OUT_OF_SCOPE: {
    label: "Fuera de scope",
    cls: "bg-zinc-200 text-zinc-700 border-zinc-300",
  },
};

export function ConciliacionBadge({
  conciliacion,
}: {
  conciliacion: ConciliacionInfo | null;
}) {
  if (!conciliacion) {
    return (
      <span className="inline-block rounded-full border border-border-soft bg-bg-soft px-2 py-0.5 text-[11px] font-semibold text-text-muted">
        Sin conciliar
      </span>
    );
  }
  const meta =
    LABELS[conciliacion.status] ?? {
      label: conciliacion.status,
      cls: "bg-zinc-100 text-zinc-700 border-zinc-200",
    };
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}
      title={`Egreso Dynatech #${conciliacion.tesoreriaExternalId}${
        conciliacion.matchType ? ` · ${conciliacion.matchType}` : ""
      }`}
    >
      {meta.label}
    </span>
  );
}
