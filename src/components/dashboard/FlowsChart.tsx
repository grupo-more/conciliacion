"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FlowsBucket } from "./types";
import { formatMoney } from "@/lib/format";

interface Props {
  flows: FlowsBucket[];
  periodLabel: string;
}

export function FlowsChart({ flows, periodLabel }: Props) {
  const data = flows.map((f) => ({
    date: shortDate(f.date),
    Ingresos: f.in,
    Egresos: -f.out, // negativo para que se vea hacia abajo
    Saldo: f.consolidatedBalance,
  }));

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">Flujo · {periodLabel}</h3>
        <div className="text-xs text-text-muted">Ingresos / Egresos / Saldo</div>
      </div>

      {flows.length === 0 ? (
        <div className="text-text-muted text-sm py-12 text-center">
          Sin movimientos en el período.
        </div>
      ) : (
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <ComposedChart
              data={data}
              margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
            >
              <defs>
                <linearGradient id="ingresosGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#16a34a" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0.6} />
                </linearGradient>
                <linearGradient id="egresosGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#dc2626" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.6} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#c8d0e6" strokeOpacity={0.5} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#5a6694", fontSize: 11 }}
                stroke="#c8d0e6"
              />
              <YAxis
                yAxisId="left"
                tick={{ fill: "#5a6694", fontSize: 11 }}
                stroke="#c8d0e6"
                tickFormatter={tickFormatter}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fill: "#5a6694", fontSize: 11 }}
                stroke="#c8d0e6"
                tickFormatter={tickFormatter}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(255, 255, 255, 0.98)",
                  border: "1px solid rgba(0, 174, 239, 0.35)",
                  borderRadius: "10px",
                  fontSize: "12px",
                  boxShadow:
                    "0 8px 24px -8px rgba(36, 58, 133, 0.25), 0 0 0 1px rgba(36, 58, 133, 0.05)",
                  backdropFilter: "blur(8px)",
                  padding: "10px 12px",
                }}
                labelStyle={{ color: "#243a85", fontWeight: 700 }}
                cursor={{ fill: "rgba(0, 174, 239, 0.08)" }}
                formatter={(value: number, name: string) => {
                  const v = name === "Egresos" ? Math.abs(value) : value;
                  return [formatMoney(v), name];
                }}
              />
              <Legend wrapperStyle={{ fontSize: "12px", color: "#5a6694" }} />
              <Bar yAxisId="left" dataKey="Ingresos" fill="url(#ingresosGrad)" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="left" dataKey="Egresos" fill="url(#egresosGrad)" radius={[0, 0, 4, 4]} />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="Saldo"
                stroke="#00aeef"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 6, fill: "#00aeef", stroke: "#ffffff", strokeWidth: 2.5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function shortDate(yyyyMmDd: string): string {
  // "2026-05-04" → "04/05"
  const [, mm, dd] = yyyyMmDd.split("-");
  return `${dd}/${mm}`;
}

function tickFormatter(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}
