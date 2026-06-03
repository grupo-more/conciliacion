"use client";

import Link from "next/link";
import type { AlertItem } from "./types";

export function Alerts({ alerts }: { alerts: AlertItem[] }) {
  if (alerts.length === 0) {
    return (
      <div className="card">
        <h3 className="text-sm font-medium mb-2">Atenciones</h3>
        <div className="text-sm text-success">✓ Todo en orden — sin alertas pendientes.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Atenciones</h3>
        <span className="text-xs text-text-muted">
          {alerts.length} alerta{alerts.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-1.5">
        {alerts.map((a, idx) => (
          <li
            key={idx}
            className={
              "text-sm rounded-md border px-3 py-2 " +
              (a.severity === "danger"
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-warn/40 bg-warn/10 text-warn")
            }
          >
            <div className="flex items-start justify-between gap-2">
              <span>{a.severity === "danger" ? "⛔" : "⚠"} {a.message}</span>
              {(a.kind === "BACKLOG" || a.kind === "REVIEW_PENDING") && (
                <Link
                  href="/dashboard/consolidados"
                  className="text-xs underline whitespace-nowrap"
                >
                  Ir a Consolidados →
                </Link>
              )}
              {a.kind === "STALE_CARTOLA" && (
                <Link
                  href="/dashboard/cartolas"
                  className="text-xs underline whitespace-nowrap"
                >
                  Ir a Cartolas →
                </Link>
              )}
              {a.kind === "SUCURSAL_INACTIVE" && (
                <Link
                  href="/dashboard/tesoreria"
                  className="text-xs underline whitespace-nowrap"
                >
                  Ir a Movimientos 200 →
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
