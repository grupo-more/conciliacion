/**
 * ANÁLISIS DE FACTIBILIDAD — Egresos a terceros: ¿se pueden cuadrar las
 * salidas de cartola (BankMovement OUT) contra los EGRESOS de /api/dynatech
 * (TesoreriaMovement, claseOperacion=EGRESO) en vez de contra los gastos
 * operativos de /api/egresos (EgresoMovement)?
 *
 * MOTIVO: la tab "Egresos a terceros" hoy ancla los candidatos y la búsqueda
 * en EgresoMovement (/api/egresos = arriendos, finiquitos, honorarios…), pero
 * las salidas a terceros reales (compra divisa, transferencias a proveedores,
 * pagos por banco) las registra DYNATECH como EGRESO (TesoreriaMovement). Son
 * dos universos distintos → por eso "nunca cuadran".
 *
 * Este script NO escribe nada. Solo compara los dos universos y reporta, sobre
 * el MISMO pool de OUT que ve la tab (no internos, no uso parcial, no ya
 * conciliados), cuántos OUT tendrían un EGRESO de dynatech del mismo monto en
 * ±N días, y por qué llave adicional calzarían (nombre / RUT / banco). Hace lo
 * mismo contra EgresoMovement para contrastar las dos fuentes lado a lado.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/compare-dynatech-egresos.ts            # ventana ±5 días
 *   npx tsx scripts/compare-dynatech-egresos.ts 7          # ventana ±7 días
 *
 * Salida:
 *   - resumen a stdout (cobertura por fuente y por llave)
 *   - dumps/compare_dynatech_egresos_<YYYY-MM-DD>.csv con los pares OUT↔EGRESO
 *     dynatech del mismo monto, para revisar a ojo patrones de glosa/nombre.
 */
import { PrismaClient } from "@prisma/client";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { normalizeRut } from "@/lib/cartolas/normalize";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { matchMirror, type BankMovementForMatch } from "@/lib/internos/match";
import { isUsoParcialAccount } from "@/lib/cuentas/uso-parcial";

const prisma = new PrismaClient({ log: ["error"] });

const DATE_WINDOW_DAYS = Number(process.argv[2]) || 5;

/* --------------------------------- helpers -------------------------------- */

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}
function d(x: Date): string {
  return x.toISOString().slice(0, 10);
}
function clp(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function pct(n: number, total: number): string {
  return total === 0 ? "0.0" : ((n / total) * 100).toFixed(1);
}
function daysBetween(a: Date, b: Date): number {
  const x = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const y = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((y.getTime() - x.getTime()) / 86400000);
}

const STOPWORDS = new Set([
  "PAGO", "PAGOS", "TRANSF", "TRANSFERENCIA", "TRF", "INTERNET", "ABONO",
  "FACT", "FACTURA", "FAC", "BOL", "BOLETA", "REF", "POR", "BANCO", "COMPRA",
  "VENTA", "USD", "SALDO", "DIF", "PDTE", "PENDIENTE", "SERVICIO", "SERVICIOS",
  "PROVEEDOR", "PROVEEDORES", "CLIENTE", "GENERICO", "SPA", "LTDA", "LIMITADA",
  "DE", "DEL", "LA", "EL", "Y", "A", "AL", "MORE", "CAPITAL",
  "ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC",
]);

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/** Tokens de nombre "fuertes" de un texto (≥4 letras, no número, no stopword). */
function nameTokens(...parts: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const p of parts) {
    if (!p) continue;
    for (const t of stripDiacritics(p).split(/[^A-Z0-9]+/)) {
      if (t.length >= 4 && !/^[0-9]+$/.test(t) && !STOPWORDS.has(t)) out.add(t);
    }
  }
  return out;
}

function rutFrom(...parts: Array<string | null | undefined>): string | null {
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(/(\d{1,2}\.?\d{3}\.?\d{3}-?[\dKk])/);
    if (m) {
      const r = normalizeRut(m[1]);
      if (r) return r;
    }
  }
  return null;
}

function shareToken(a: Set<string>, b: Set<string>): string | null {
  for (const t of a) if (b.has(t)) return t;
  return null;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log("=".repeat(72));
  console.log(`COMPARACIÓN  cartola OUT  ↔  EGRESO dynatech  (ventana ±${DATE_WINDOW_DAYS} días)`);
  console.log("=".repeat(72));

  // ---- Universo de cartola (idéntico al motor de egresos a terceros) ----
  const [allBms, entidades, manualConcs, tesoreriaLinks] = await Promise.all([
    prisma.bankMovement.findMany({
      where: { direction: { in: ["IN", "OUT"] } },
      include: { account: true },
      orderBy: { postDate: "asc" },
    }),
    loadEntidadesInternas(prisma),
    prisma.egresoConciliacion.findMany({ where: { status: "MANUAL" }, include: { links: true } }),
    prisma.consolidadoLink.findMany({ select: { bankMovementId: true } }),
  ]);

  const manualBmIds = new Set<string>();
  for (const c of manualConcs) for (const l of c.links) manualBmIds.add(l.bankMovementId);
  const tesoreriaLinked = new Set(tesoreriaLinks.map((l) => l.bankMovementId));

  const forMatch: BankMovementForMatch[] = allBms.map((bm) => ({
    id: bm.id, accountId: bm.accountId, postDate: bm.postDate, amount: bm.amount,
    direction: bm.direction, description: bm.description,
    counterpartyName: bm.counterpartyName, counterpartyRut: bm.counterpartyRut,
    account: {
      id: bm.account.id, bankName: bm.account.bankName, holderName: bm.account.holderName,
      holderRut: bm.account.holderRut, accountNumber: bm.account.accountNumber,
      displayNumber: bm.account.displayNumber,
    },
  }));
  const internalOutIds = new Set(matchMirror(forMatch, entidades).pairs.map((p) => p.out.id));

  // Pool exacto que ve la tab "Egresos a terceros".
  const outPool = allBms.filter(
    (bm) =>
      bm.direction === "OUT" &&
      !tesoreriaLinked.has(bm.id) &&
      !internalOutIds.has(bm.id) &&
      !manualBmIds.has(bm.id) &&
      !isUsoParcialAccount(bm.account),
  );

  // ---- Las dos fuentes candidatas ----
  // (1) EGRESO de dynatech = TesoreriaMovement clase/tipo EGRESO.
  const egresosDyna = await prisma.tesoreriaMovement.findMany({
    where: { OR: [{ claseOperacion: "EGRESO" }, { tipoOperacion: "EGRESO" }] },
    include: { consolidado: { select: { status: true } } },
    orderBy: { fecha: "asc" },
  });
  // (2) Gasto operativo = EgresoMovement (fuente actual de la tab).
  const egresosOp = await prisma.egresoMovement.findMany({ orderBy: { fecha: "asc" } });

  // Index por monto absoluto.
  const dynaByAmt = new Map<string, typeof egresosDyna>();
  for (const e of egresosDyna) {
    const k = absBig(e.monto).toString();
    (dynaByAmt.get(k) ?? dynaByAmt.set(k, []).get(k)!).push(e);
  }
  const opByAmt = new Map<string, typeof egresosOp>();
  for (const e of egresosOp) {
    const k = absBig(e.monto).toString();
    (opByAmt.get(k) ?? opByAmt.set(k, []).get(k)!).push(e);
  }

  console.log(`\nOUT en pool (egresos a terceros) : ${outPool.length}`);
  console.log(`EGRESO dynatech (TesoreriaMovement) : ${egresosDyna.length}`);
  console.log(`  · ya conciliados por motor principal:`,
    summarizeStatus(egresosDyna.map((e) => e.consolidado?.status ?? "SIN_PROCESAR")));
  console.log(`Gasto operativo (EgresoMovement)    : ${egresosOp.length}`);

  // ---- Cobertura OUT contra cada fuente ----
  const win = DATE_WINDOW_DAYS;
  const dyna = { amount: 0, plusName: 0, plusRut: 0, plusBanco: 0 };
  const op = { amount: 0, plusName: 0 };
  // Clasificación para AUTO-MATCH (qué tan seguro es resolverlo solo):
  const auto = {
    unico: 0,        // 1 solo egreso dynatech por monto+fecha → 1:1 directo
    desempBanco: 0,  // varios, pero solo 1 coincide en banco
    desempNombre: 0, // varios, pero solo 1 comparte token de nombre
    ambiguo: 0,      // varios y nada los desempata → manual
  };
  const rows: string[][] = [];

  for (const bm of outPool) {
    const amt = absBig(bm.amount).toString();
    const bmNames = nameTokens(bm.counterpartyName, bm.description);
    const bmRut = rutFrom(bm.counterpartyRut, bm.description, bm.counterpartyName);
    const bmBank = stripDiacritics(bm.account.bankName ?? "");

    // --- dynatech ---
    const dCands = (dynaByAmt.get(amt) ?? []).filter(
      (e) => Math.abs(daysBetween(e.fecha, bm.postDate)) <= win,
    );
    if (dCands.length > 0) {
      dyna.amount++;
      let hasName = false, hasRut = false, hasBank = false;
      // ¿cuántos candidatos calzan cada llave de desempate?
      let nBank = 0, nName = 0;
      for (const e of dCands) {
        const eNames = nameTokens(e.glosa, e.clienteName);
        const eRut = rutFrom(e.glosa, e.clienteRut, e.clienteName);
        const tok = shareToken(bmNames, eNames);
        const rutOk = !!(bmRut && eRut && bmRut === eRut);
        const bankOk = !!(e.banco && bmBank && stripDiacritics(e.banco).includes(bmBank.split(" ")[0]));
        if (tok) { hasName = true; nName++; }
        if (rutOk) hasRut = true;
        if (bankOk) { hasBank = true; nBank++; }
        rows.push([
          d(bm.postDate), bm.account.bankName, bm.account.displayNumber ?? bm.account.accountNumber,
          clp(absBig(bm.amount)), bm.counterpartyName ?? "", bm.counterpartyRut ?? "", bm.description ?? "",
          "→", d(e.fecha), e.banco ?? "", e.glosa, e.consolidado?.status ?? "SIN_PROCESAR",
          tok ? `NOMBRE:${tok}` : "", rutOk ? `RUT:${bmRut}` : "", bankOk ? "BANCO" : "",
          String(daysBetween(e.fecha, bm.postDate)), String(dCands.length),
        ]);
      }
      if (hasName) dyna.plusName++;
      if (hasRut) dyna.plusRut++;
      if (hasBank) dyna.plusBanco++;
      // tier de auto-match
      if (dCands.length === 1) auto.unico++;
      else if (nBank === 1) auto.desempBanco++;
      else if (nName === 1) auto.desempNombre++;
      else auto.ambiguo++;
    }

    // --- EgresoMovement (fuente actual) ---
    const oCands = (opByAmt.get(amt) ?? []).filter(
      (e) => Math.abs(daysBetween(e.fecha, bm.postDate)) <= win,
    );
    if (oCands.length > 0) {
      op.amount++;
      const hasName = oCands.some((e) => shareToken(bmNames, nameTokens(e.glosa)));
      if (hasName) op.plusName++;
    }
  }

  // ---- Reporte ----
  const T = outPool.length;
  console.log("\n" + "-".repeat(72));
  console.log(`COBERTURA del pool de OUT (${T} movimientos), por fuente y llave:`);
  console.log("-".repeat(72));
  console.log(`\n  A) contra EGRESO dynatech (lo que proponés usar):`);
  console.log(`     monto + fecha ±${win}d ............ ${dyna.amount}  (${pct(dyna.amount, T)}%)`);
  console.log(`       └ además comparte NOMBRE ....... ${dyna.plusName}  (${pct(dyna.plusName, T)}%)`);
  console.log(`       └ además coincide RUT .......... ${dyna.plusRut}  (${pct(dyna.plusRut, T)}%)`);
  console.log(`       └ además coincide BANCO ........ ${dyna.plusBanco}  (${pct(dyna.plusBanco, T)}%)`);
  console.log(`\n  B) contra EgresoMovement (fuente actual de la tab):`);
  console.log(`     monto + fecha ±${win}d ............ ${op.amount}  (${pct(op.amount, T)}%)`);
  console.log(`       └ además comparte NOMBRE ....... ${op.plusName}  (${pct(op.plusName, T)}%)`);

  // ---- Tiers de AUTO-MATCH (sobre los ${dyna.amount} OUT con egreso dynatech del mismo monto+fecha) ----
  const M = dyna.amount;
  console.log("\n" + "-".repeat(72));
  console.log(`FACTIBILIDAD DE AUTO-MATCH (de los ${M} OUT con egreso dynatech mismo monto+fecha):`);
  console.log("-".repeat(72));
  console.log(`  1:1 ÚNICO (auto directo) ........... ${auto.unico}  (${pct(auto.unico, M)}% de los ${M})`);
  console.log(`  ambiguo, desempata BANCO ........... ${auto.desempBanco}  (${pct(auto.desempBanco, M)}%)`);
  console.log(`  ambiguo, desempata NOMBRE .......... ${auto.desempNombre}  (${pct(auto.desempNombre, M)}%)`);
  console.log(`  ambiguo SIN desempate → MANUAL ..... ${auto.ambiguo}  (${pct(auto.ambiguo, M)}%)`);
  const autoTotal = auto.unico + auto.desempBanco + auto.desempNombre;
  console.log(`  → AUTO-MATCHEABLE estimado: ${autoTotal}  (${pct(autoTotal, T)}% del pool total de ${T})`);

  // ---- CSV ----
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dumpsDir, `compare_dynatech_egresos_${today}.csv`);
  const ws = createWriteStream(outPath, { encoding: "utf8" });
  ws.write("﻿");
  ws.write([
    "out_fecha", "out_banco", "out_cuenta", "out_monto", "out_contraparte", "out_rut", "out_glosa",
    "", "dyna_fecha", "dyna_banco", "dyna_glosa", "dyna_estado_conc",
    "llave_nombre", "llave_rut", "llave_banco", "delta_dias", "n_candidatos",
  ].join(",") + "\n");
  for (const r of rows) ws.write(r.map(csvEscape).join(",") + "\n");
  await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())));

  console.log("\n" + "-".repeat(72));
  console.log(`Pares OUT↔EGRESO dynatech del mismo monto escritos: ${rows.length}`);
  console.log(`CSV: ${outPath}  (dumps/ está gitignored)`);
  console.log("-".repeat(72));
  console.log("\nLECTURA:");
  console.log("  • Compará A vs B. Si A (dynatech) cubre mucho más que B, confirma");
  console.log("    que la tab está mirando la fuente equivocada.");
  console.log("  • 'monto+fecha' es el techo de lo automatizable; las sub-líneas");
  console.log("    (nombre/rut/banco) son lo que se puede auto-confirmar con baja");
  console.log("    probabilidad de falso positivo. El resto sería sugerencia manual.");
  console.log("  • Abrí el CSV y mirá los pares sin nombre/rut: ahí se ve si hay otro");
  console.log("    patrón recurrente (folio, banco, glosa) que sirva como llave.");

  await prisma.$disconnect();
}

function summarizeStatus(statuses: string[]): string {
  const c = new Map<string, number>();
  for (const s of statuses) c.set(s, (c.get(s) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ");
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
