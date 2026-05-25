"use client";

import type { AccountBalance } from "./types";
import { formatDate, formatMoney } from "@/lib/format";

interface Props {
  balances: AccountBalance[];
  periodLabel: string;
}

export function BalancesTable({ balances, periodLabel }: Props) {
  const totalBalance = balances.reduce((acc, b) => acc + b.balance, 0);
  const totalIn = balances.reduce((acc, b) => acc + b.inSumInPeriod, 0);
  const totalReconciled = balances.reduce((acc, b) => acc + b.reconciledInSum, 0);
  const totalOther = balances.reduce((acc, b) => acc + b.otherInSum, 0);
  const reconciledPct = totalIn > 0 ? (totalReconciled / totalIn) * 100 : 0;
  const otherPct = totalIn > 0 ? (totalOther / totalIn) * 100 : 0;

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-border-soft">
        <h3 className="text-sm font-medium">Cuentas y saldos</h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-soft text-xs uppercase text-text-muted tracking-wider border-b border-border-soft">
            <tr>
              <th className="px-3 py-2 text-left">Empresa</th>
              <th className="px-3 py-2 text-left">Banco · Cuenta</th>
              <th className="px-3 py-2 text-right">Saldo</th>
              <th className="px-3 py-2 text-left">Actualizado</th>
              <th className="px-3 py-2 text-right">Mov. {periodLabel.toLowerCase()}</th>
              <th className="px-3 py-2 text-right">Ingresos</th>
            </tr>
          </thead>
          <tbody>
            {balances.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                  Sin cuentas registradas.
                </td>
              </tr>
            )}
            {balances.map((b) => {
              const fresh = freshness(b.daysSinceLastMovement);
              return (
                <tr key={b.id} className="border-t border-border-soft/60 table-row-hover">
                  <td className="px-3 py-2 font-medium">{b.holderName}</td>
                  <td className="px-3 py-2">
                    <div className="text-xs">{b.bankName}</div>
                    <div className="text-xs text-text-muted font-mono">
                      {b.displayNumber || b.accountNumber}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    {formatMoney(b.balance)}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {b.lastMovementDate ? (
                      <>
                        <span className={fresh.cls}>{fresh.label}</span>
                        <span className="text-text-muted ml-1">
                          ({formatDate(b.lastMovementDate)})
                        </span>
                      </>
                    ) : (
                      <span className="text-text-dim">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">
                    {b.movementCountInPeriod}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-success whitespace-nowrap">
                    +{formatMoney(b.inSumInPeriod)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-bg-soft border-t-2 border-border">
            <tr>
              <td colSpan={2} className="px-3 py-2 font-medium">TOTAL</td>
              <td className="px-3 py-2 text-right font-mono font-semibold">
                {formatMoney(totalBalance)}
              </td>
              <td colSpan={2}></td>
              <td className="px-3 py-2 text-right font-mono text-success">
                +{formatMoney(totalIn)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Saldo conciliado vs otros */}
      {totalIn > 0 && (
        <div className="px-4 py-3 border-t border-border-soft bg-bg-soft/50">
          <div className="text-xs text-text-muted mb-2">
            Ingresos {periodLabel.toLowerCase()}: respaldo Dynatech vs otros
          </div>
          <div className="flex h-3 rounded-full overflow-hidden bg-bg-elevated ring-1 ring-border-soft">
            {reconciledPct > 0 && (
              <div
                className="bg-success/70"
                style={{ width: `${reconciledPct}%` }}
                title={`${reconciledPct.toFixed(1)}% conciliado`}
              />
            )}
            {otherPct > 0 && (
              <div
                className="bg-text-muted/40"
                style={{ width: `${otherPct}%` }}
                title={`${otherPct.toFixed(1)}% otros`}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm bg-success/70" />
              <span className="text-success">
                Conciliado: {formatMoney(totalReconciled)} ({reconciledPct.toFixed(0)}%)
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-sm bg-text-muted/40" />
              <span className="text-text-muted">
                Otros: {formatMoney(totalOther)} ({otherPct.toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function freshness(days: number | null): { label: string; cls: string } {
  if (days === null) return { label: "Sin datos", cls: "text-text-dim" };
  if (days <= 1) return { label: "Al día", cls: "text-success" };
  if (days <= 3) return { label: `${days}d`, cls: "text-success" };
  if (days <= 7) return { label: `${days}d`, cls: "text-warn" };
  return { label: `${days}d ⚠`, cls: "text-danger" };
}
