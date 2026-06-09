"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { formatDate, formatMoney } from "@/lib/format";
import {
  type BancoResponse,
  type BankTag,
  BANK_TAG_LABEL,
  BANK_TAG_COLOR,
  AGING_LABEL,
} from "./types";
import { KpiCard, AgingBar, Breakdown, CategoryChips } from "./ReportPieces";

const TAG_KEYS: BankTag[] = ["interno", "transbank", "comision", "sin_clasificar"];

/**
 * Reporte: movimientos de cartola (banco) sin conciliar. Cada fila etiquetada
 * (interno / transbank / comision / sin clasificar) para separar el ruido
 * esperado de la brecha real, con aging y export a Excel.
 */
export function BancoSinConciliarView({
  from,
  to,
  onRangeChange,
}: {
  from: string;
  to: string;
  onRangeChange: (from: string, to: string) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<"" | "IN" | "OUT">("");
  const [tag, setTag] = useState<BankTag | "">("");
  const [data, setData] = useState<BancoResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (accountId) p.set("accountId", accountId);
      if (direction) p.set("direction", direction);
      if (tag) p.set("tag", tag);
      const res = await fetch(`/api/reportes/banco-sin-conciliar?${p}`);
      setData(res.ok ? await res.json() : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, accountId, direction, tag]);

  const totalMonto = useMemo(
    () => (data ? BigInt(data.resumen.monto) : 0n),
    [data],
  );
  const hasRows = !!data && data.rows.length > 0;

  function exportXlsx() {
    if (!data || data.rows.length === 0) return;
    const wb = XLSX.utils.book_new();

    // Hoja 1: Resumen (autodocumentado).
    const r = data.resumen;
    const resumenAoa: (string | number)[][] = [
      ["Reporte", "Movimientos de banco sin conciliar"],
      ["Rango", `${from} a ${to}`],
      ["Filtros", filtrosLabel(accountId, direction, tag, data)],
      [],
      ["Total movimientos", r.count],
      ["Monto total", Number(r.monto)],
      [],
      ["Por dirección", "Cantidad", "Monto"],
      ["Ingresos (IN)", r.porDireccion.IN?.count ?? 0, Number(r.porDireccion.IN?.monto ?? 0)],
      ["Egresos (OUT)", r.porDireccion.OUT?.count ?? 0, Number(r.porDireccion.OUT?.monto ?? 0)],
      [],
      ["Por clasificación", "Cantidad", "Monto"],
      ...TAG_KEYS.map((k) => [
        BANK_TAG_LABEL[k],
        r.porTag[k]?.count ?? 0,
        Number(r.porTag[k]?.monto ?? 0),
      ]),
      [],
      ["Por antigüedad", "Cantidad", "Monto"],
      ...(["0-7", "8-30", "31-60", "60+"] as const).map((b) => [
        AGING_LABEL[b],
        r.porAging[b]?.count ?? 0,
        Number(r.porAging[b]?.monto ?? 0),
      ]),
    ];
    const resumenSheet = XLSX.utils.aoa_to_sheet(resumenAoa);
    resumenSheet["!cols"] = [{ wch: 26 }, { wch: 14 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, resumenSheet, "Resumen");

    // Hoja 2: Detalle.
    const aoa: (string | number)[][] = [
      [
        "Fecha",
        "Edad (días)",
        "Banco",
        "Cuenta",
        "Dirección",
        "Monto",
        "Clasificación",
        "RUT contraparte",
        "Nombre contraparte",
        "Glosa",
      ],
    ];
    for (const row of data.rows) {
      aoa.push([
        formatDate(row.fecha),
        row.aging,
        row.holderName ? `${row.bankName} ${row.holderName}` : row.bankName,
        row.accountNumber,
        row.direction,
        row.direction === "OUT" ? -Number(row.monto) : Number(row.monto),
        BANK_TAG_LABEL[row.tag],
        row.counterpartyRut ?? "",
        row.counterpartyName ?? "",
        row.description ?? "",
      ]);
    }
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!cols"] = [
      { wch: 12 },
      { wch: 11 },
      { wch: 16 },
      { wch: 16 },
      { wch: 10 },
      { wch: 14 },
      { wch: 16 },
      { wch: 14 },
      { wch: 26 },
      { wch: 40 },
    ];
    XLSX.utils.book_append_sheet(wb, sheet, "Detalle");

    XLSX.writeFile(wb, `banco_sin_conciliar_${from}_${to}.xlsx`);
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <DateInput label="Desde" value={from} onChange={(v) => onRangeChange(v, to)} />
        <DateInput label="Hasta" value={to} onChange={(v) => onRangeChange(from, v)} />
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
          value={direction}
          onChange={(e) => setDirection(e.target.value as "" | "IN" | "OUT")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Ingresos y egresos</option>
          <option value="IN">Solo ingresos (IN)</option>
          <option value="OUT">Solo egresos (OUT)</option>
        </select>
        <select
          value={tag}
          onChange={(e) => setTag(e.target.value as BankTag | "")}
          className="rounded-md border border-border-soft px-3 py-1.5 text-sm bg-white"
        >
          <option value="">Todas las clasificaciones</option>
          {TAG_KEYS.map((k) => (
            <option key={k} value={k}>
              {BANK_TAG_LABEL[k]}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          onClick={exportXlsx}
          disabled={!hasRows}
          className="rounded-md bg-brand text-white px-3 py-1.5 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
        >
          Descargar Excel
        </button>
      </div>

      {/* Resumen / KPIs */}
      {data && (
        <>
          <div className="flex flex-wrap gap-3">
            <KpiCard
              label="Sin conciliar"
              count={data.resumen.count}
              monto={data.resumen.monto}
              tone="danger"
            />
            <KpiCard
              label="Ingresos (IN)"
              count={data.resumen.porDireccion.IN?.count ?? 0}
              monto={data.resumen.porDireccion.IN?.monto ?? "0"}
            />
            <KpiCard
              label="Egresos (OUT)"
              count={data.resumen.porDireccion.OUT?.count ?? 0}
              monto={data.resumen.porDireccion.OUT?.monto ?? "0"}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <AgingBar porAging={data.resumen.porAging} />
            <CategoryChips
              title="Por clasificación"
              items={TAG_KEYS.map((k) => ({
                key: k,
                label: BANK_TAG_LABEL[k],
                count: data.resumen.porTag[k]?.count ?? 0,
                monto: data.resumen.porTag[k]?.monto ?? "0",
                cls: BANK_TAG_COLOR[k],
              }))}
            />
          </div>
          <Breakdown title="Por cuenta" rows={data.resumen.porBanco} />
        </>
      )}

      {data &&
        (data.resumen.resueltos.transbank.count > 0 ||
          data.resumen.resueltos.traspasos.count > 0 ||
          data.resumen.resueltos.noRelevante.count > 0) && (
          <div className="rounded-md border border-emerald-300 bg-emerald-50 text-emerald-800 px-3 py-2 text-xs space-y-0.5">
            <div className="font-semibold">
              Excluidos de la brecha:
            </div>
            {data.resumen.resueltos.transbank.count > 0 && (
              <div>
                ✓ {data.resumen.resueltos.transbank.count} abono
                {data.resumen.resueltos.transbank.count === 1 ? "" : "s"} Transbank
                ({formatMoney(BigInt(data.resumen.resueltos.transbank.monto))}) →{" "}
                <strong>Abono Transbank</strong>
              </div>
            )}
            {data.resumen.resueltos.traspasos.count > 0 && (
              <div>
                ✓ {data.resumen.resueltos.traspasos.count} movimiento
                {data.resumen.resueltos.traspasos.count === 1 ? "" : "s"} de
                traspaso interno (
                {formatMoney(BigInt(data.resumen.resueltos.traspasos.monto))}) →{" "}
                <strong>Traspasos internos</strong>
              </div>
            )}
            {data.resumen.resueltos.noRelevante.count > 0 && (
              <div>
                ✓ {data.resumen.resueltos.noRelevante.count} movimiento
                {data.resumen.resueltos.noRelevante.count === 1 ? "" : "s"} de
                cuentas de uso parcial (
                {formatMoney(BigInt(data.resumen.resueltos.noRelevante.monto))}) →{" "}
                no relevantes
              </div>
            )}
          </div>
        )}

      {data?.truncated && (
        <div className="rounded-md border border-amber-300 bg-amber-50 text-amber-800 px-3 py-2 text-xs">
          ⚠ Se muestran las primeras 5.000 filas. Acotá el rango para ver el resto.
        </div>
      )}

      {/* Tabla */}
      <div className="rounded-lg border border-border-soft bg-white overflow-hidden">
        {loading && (
          <div className="text-center py-8 text-sm text-text-muted">Cargando…</div>
        )}
        {!loading && !hasRows && (
          <div className="text-center py-8 text-sm text-text-muted">
            🎉 No hay movimientos de banco sin conciliar en este filtro.
          </div>
        )}
        {!loading && hasRows && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-right">Edad</th>
                  <th className="px-3 py-2 text-left">Cuenta</th>
                  <th className="px-3 py-2 text-center">Dir.</th>
                  <th className="px-3 py-2 text-right">Monto</th>
                  <th className="px-3 py-2 text-left">Clasificación</th>
                  <th className="px-3 py-2 text-left">Contraparte</th>
                  <th className="px-3 py-2 text-left">Glosa</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-border-soft/60 hover:bg-bg-soft/40"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {formatDate(row.fecha)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <AgingTag days={row.aging} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="text-text">
                        {row.bankName}
                        {row.holderName ? ` ${row.holderName}` : ""}
                      </div>
                      <div className="text-xs text-text-muted font-mono">
                        {row.accountNumber}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={
                          "text-[11px] font-bold " +
                          (row.direction === "OUT"
                            ? "text-rose-600"
                            : "text-emerald-600")
                        }
                      >
                        {row.direction}
                      </span>
                    </td>
                    <td
                      className={
                        "px-3 py-2 text-right font-mono whitespace-nowrap " +
                        (row.direction === "OUT" ? "text-rose-600" : "text-text")
                      }
                    >
                      {row.direction === "OUT" ? "-" : ""}
                      {formatMoney(BigInt(row.monto))}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${BANK_TAG_COLOR[row.tag]}`}
                      >
                        {BANK_TAG_LABEL[row.tag]}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 max-w-[200px] truncate"
                      title={`RUT: ${row.counterpartyRut ?? "—"}\nNombre: ${row.counterpartyName ?? "—"}`}
                    >
                      {row.counterpartyName || row.counterpartyRut || (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 max-w-[280px] truncate"
                      title={row.description ?? ""}
                    >
                      {row.description ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-bg-soft">
                <tr className="border-t-2 border-border-soft">
                  <td className="px-3 py-2 font-semibold" colSpan={4}>
                    TOTAL ({data!.resumen.count})
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {formatMoney(totalMonto)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function filtrosLabel(
  accountId: string,
  direction: string,
  tag: string,
  data: BancoResponse,
): string {
  const parts: string[] = [];
  if (accountId)
    parts.push(
      "Cuenta: " +
        (data.facets.accounts.find((a) => a.id === accountId)?.label ?? accountId),
    );
  if (direction) parts.push(`Dirección: ${direction}`);
  if (tag) parts.push(`Clasificación: ${BANK_TAG_LABEL[tag as BankTag]}`);
  return parts.length ? parts.join(" · ") : "Sin filtros";
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="text-text-muted">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border-soft px-2 py-1.5 text-sm bg-white"
      />
    </label>
  );
}

function AgingTag({ days }: { days: number }) {
  const cls =
    days > 60
      ? "text-rose-600 font-bold"
      : days > 30
        ? "text-orange-600 font-semibold"
        : days > 7
          ? "text-amber-600"
          : "text-text-muted";
  return <span className={`text-xs tabular-nums ${cls}`}>{days}d</span>;
}
