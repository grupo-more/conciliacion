/**
 * Dump de diagnóstico del asiento de Cuadratura Transbank: para CADA movimiento
 * cuadrado (POS ↔ settlement) muestra boleta, neto, comisión API (Dynatech),
 * comisión cartola, lo que iría al 708 y al 1403, agrupado por sucursal.
 *
 * Sirve para responder "¿por qué el 1403 es más grande que el 708?": si la
 * comisión API que captura el feed es mucho menor que la real de cartola, el
 * 1403 se infla. Con el dump se ve movimiento a movimiento.
 *
 * Uso (EN EL SERVER, DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/dump-cuadratura.ts                 (todo el histórico)
 *   npx tsx scripts/dump-cuadratura.ts 2026-06-01 2026-06-15
 *
 * Salida: dumps/cuadratura_<YYYY-MM-DD>.csv  +  .json  (gitignored)
 */

import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const MATCH_TOLERANCE = 0.05;
const abs = (n: bigint) => (n < 0n ? -n : n);

async function main() {
  const [, , fromArg, toArg] = process.argv;
  const from = fromArg ? new Date(`${fromArg}T00:00:00`) : new Date("2000-01-01");
  const to = toArg ? new Date(`${toArg}T23:59:59`) : new Date("2999-01-01");

  const [posAll, settAll] = await Promise.all([
    prisma.tbkTesoreria.findMany({
      where: { fecha: { gte: from, lte: to }, estadoActual: { not: "ANU" } },
      orderBy: { fecha: "desc" },
    }),
    prisma.transbankSale.findMany({
      where: { fechaVenta: { gte: from, lte: to } },
      orderBy: { fechaVenta: "desc" },
    }),
  ]);

  // --- Matching (misma lógica que el módulo: boleta+monto, luego monto+fecha) ---
  const settByBoleta = new Map<string, typeof settAll>();
  for (const s of settAll) {
    if (!s.numeroBoleta) continue;
    (settByBoleta.get(s.numeroBoleta) ?? settByBoleta.set(s.numeroBoleta, []).get(s.numeroBoleta)!).push(s);
  }
  const used = new Set<string>();
  type Pair = { pos: (typeof posAll)[number]; sett: (typeof settAll)[number] };
  const pairs: Pair[] = [];
  const unmatched: typeof posAll = [];
  for (const pos of posAll) {
    let best: (typeof settAll)[number] | null = null;
    let bestDiff = 0n;
    const base = abs(pos.monto);
    for (const c of settByBoleta.get(pos.opNumber ?? "") ?? []) {
      if (used.has(c.id)) continue;
      const diff = c.montoVenta - pos.monto;
      if (base > 0n && Number(abs(diff)) / Number(base) > MATCH_TOLERANCE) continue;
      if (best === null || abs(diff) < abs(bestDiff)) { best = c; bestDiff = diff; }
    }
    if (best) { used.add(best.id); pairs.push({ pos, sett: best }); } else unmatched.push(pos);
  }
  const dayMs = 86400000;
  for (const pos of unmatched) {
    const c = settAll.find((s) => !used.has(s.id) && s.montoVenta === pos.monto &&
      Math.abs(pos.fecha.getTime() - s.fechaVenta.getTime()) <= dayMs * 1.5 &&
      (s.sucursalId == null || s.sucursalId === pos.sucursalId));
    if (c) { used.add(c.id); pairs.push({ pos, sett: c }); }
  }

  // --- Breakdown por movimiento ---
  type Row = {
    sucursalId: number; sucursal: string; fecha: string; boleta: string; medio: string;
    boletaMonto: bigint; transbankBruto: bigint; neto: bigint;
    comisionApi: bigint; comisionCartola: bigint; c708: bigint; dif1403: bigint;
  };
  const rows: Row[] = [];
  for (const { pos, sett } of pairs) {
    const comApi = pos.comisionMonto ?? 0n;
    const comCartola = sett.comision + sett.ivaComision;
    const c708 = comApi > 0n ? comApi : comCartola;
    rows.push({
      sucursalId: pos.sucursalId,
      sucursal: pos.sucursalName ?? `#${pos.sucursalId}`,
      fecha: pos.fecha.toISOString().slice(0, 10),
      boleta: pos.opNumber ?? sett.numeroBoleta ?? "",
      medio: sett.medioPago,
      boletaMonto: abs(pos.monto),
      transbankBruto: sett.totalAbono + comCartola,
      neto: sett.totalAbono,
      comisionApi: comApi,
      comisionCartola: comCartola,
      c708,
      dif1403: comCartola - c708,
    });
  }

  // --- Resumen por sucursal ---
  const bySuc = new Map<number, { sucursal: string; n: number; conApi: number; sinApi: number; com708: bigint; dif1403: bigint; comCartola: bigint }>();
  for (const r of rows) {
    let g = bySuc.get(r.sucursalId);
    if (!g) { g = { sucursal: r.sucursal, n: 0, conApi: 0, sinApi: 0, com708: 0n, dif1403: 0n, comCartola: 0n }; bySuc.set(r.sucursalId, g); }
    g.n++; if (r.comisionApi > 0n) g.conApi++; else g.sinApi++;
    g.com708 += r.c708; g.dif1403 += r.dif1403; g.comCartola += r.comisionCartola;
  }

  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  // CSV por movimiento
  const csvHead = "sucursal;fecha;boleta;medio;boleta_monto;transbank_bruto;neto;comision_api;comision_cartola;va_al_708;va_al_1403";
  const csvBody = rows.map((r) => [r.sucursal, r.fecha, r.boleta, r.medio,
    r.boletaMonto, r.transbankBruto, r.neto, r.comisionApi, r.comisionCartola, r.c708, r.dif1403].join(";")).join("\n");
  const csvPath = resolve(dumpsDir, `cuadratura_${today}.csv`);
  writeFileSync(csvPath, `${csvHead}\n${csvBody}`, "utf8");

  const jsonPath = resolve(dumpsDir, `cuadratura_${today}.json`);
  writeFileSync(jsonPath, JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), "utf8");

  // Consola: resumen por sucursal
  console.log("=".repeat(70));
  console.log("CUADRATURA — resumen por sucursal (cuadrados:", rows.length, ")");
  console.log("=".repeat(70));
  for (const [, g] of [...bySuc.entries()].sort((a, b) => Number(b[1].com708 + b[1].dif1403 - a[1].com708 - a[1].dif1403))) {
    console.log(
      `${g.sucursal.padEnd(16)} movs:${String(g.n).padStart(4)} (conAPI:${g.conApi} sinAPI:${g.sinApi}) ` +
      `| 708:${fmt(g.com708).padStart(12)} | 1403:${fmt(g.dif1403).padStart(12)} | comisión real:${fmt(g.comCartola).padStart(12)}`,
    );
  }
  console.log(`\nCSV : ${csvPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log("Abrí el CSV en Excel (separador ;) para ver cada movimiento.");

  await prisma.$disconnect();
}

function fmt(n: bigint): string {
  return n.toLocaleString("es-CL");
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
