import { readFileSync } from "fs";
const db = JSON.parse(readFileSync(process.argv[2] || "dump/db_dump_2026-06-08.json", "utf8"));
const A = (n) => { n = BigInt(n); return n < 0n ? -n : n; };
const dd = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;
const strip = (s) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const P = (...a) => console.log(...a);

const tms = db.tesoreriaMovements;
const ingresos = tms.filter((t) => t.tipoOperacion !== "EGRESO" && BigInt(t.monto) >= 0n);
const bank = db.bankMovements;
const bankIN = bank.filter((b) => b.direction === "IN");
const bankOUT = bank.filter((b) => b.direction === "OUT");
const tbk = db.tbkTesoreria;
const egr = db.egresoMovement;

const st = (t) => t.consolidado?.status ?? "UNPROCESSED";
const dist = {};
for (const t of ingresos) dist[st(t)] = (dist[st(t)] || 0) + 1;
P("=== INGRESOS (Comparar) por estado ===");
P(JSON.stringify(dist, null, 1));

const noMatch = ingresos.filter((t) => ["NO_MATCH", "UNPROCESSED", "REVIEW", "OUT_OF_SCOPE"].includes(st(t)));
P(`\nNO conciliados (NO_MATCH/UNPROCESSED/REVIEW/OUT_OF_SCOPE): ${noMatch.length}`);

// índices por |monto|
const idx = (arr, amtFn) => { const m = new Map(); for (const x of arr) { const k = A(amtFn(x)).toString(); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };
const inByAmt = idx(bankIN, (b) => b.amount);
const outByAmt = idx(bankOUT, (b) => b.amount);
const tbkByAmt = idx(tbk, (t) => t.monto);
const egrByAmt = idx(egr, (e) => e.monto);

let cBankIN = 0, cBankINfree = 0, cBankOUT = 0, cTbk = 0, cEgr = 0, cNada = 0;
const ej = { tbk: [], out: [], egr: [], inFree: [] };
for (const t of noMatch) {
  const mag = A(t.monto).toString();
  const win = (arr) => (arr.get(mag) || []).filter((x) => dd(t.fecha, x.postDate ?? x.fecha ?? x.fechaVenta) <= 7);
  const insC = win(inByAmt);
  const outC = win(outByAmt);
  const tbkC = win(tbkByAmt);
  const egrC = win(egrByAmt);
  if (insC.length) {
    cBankIN++;
    const free = insC.filter((b) => !b.linkCount);
    if (free.length) { cBankINfree++; if (ej.inFree.length < 5) ej.inFree.push({ t, b: free[0] }); }
  }
  if (outC.length) { cBankOUT++; if (ej.out.length < 5) ej.out.push({ t, b: outC[0] }); }
  if (tbkC.length) { cTbk++; if (ej.tbk.length < 6) ej.tbk.push({ t, x: tbkC[0] }); }
  if (egrC.length) { cEgr++; if (ej.egr.length < 5) ej.egr.push({ t, x: egrC[0] }); }
  if (!insC.length && !outC.length && !tbkC.length && !egrC.length) cNada++;
}

P("\n=== ¿dónde está la contraparte de los NO conciliados? (mismo monto ±7d) ===");
P(`En cartola IN (debería haber matcheado):   ${cBankIN}  (de esos LIBRE: ${cBankINfree})`);
P(`En cartola OUT (dirección/interno):         ${cBankOUT}`);
P(`En feed TBK (era venta tarjeta rubro 17):   ${cTbk}`);
P(`En feed Egresos (era un gasto):             ${cEgr}`);
P(`Sin rastro en ninguna fuente:               ${cNada}`);

P("\n--- ej: NO conciliado que aparece en TBK (posible venta tarjeta) ---");
for (const e of ej.tbk) P(`  ING $${e.t.monto} ${e.t.fecha.slice(0,10)} banco="${e.t.banco}" "${e.t.glosa}"  ↔ TBK suc=${e.x.sucursalName} op=${e.x.opNumber} "${e.x.glosa}"`);
P("\n--- ej: NO conciliado con cartola IN LIBRE (near-miss recuperable) ---");
for (const e of ej.inFree) P(`  ING $${e.t.monto} ${e.t.fecha.slice(0,10)} banco="${e.t.banco}" cli="${e.t.clienteName}" ↔ IN ${e.b.bankName} cp="${e.b.counterpartyName}" "${(e.b.description||"").slice(0,40)}"`);
P("\n--- ej: NO conciliado que aparece en Egresos ---");
for (const e of ej.egr) P(`  ING $${e.t.monto} "${e.t.glosa}"  ↔ EGRESO [${e.x.rubroNombre}] "${e.x.glosa}"`);

// banco IN sin link (lo que el usuario ve en Comparar como "sin matchear" del lado banco)
const inUnlinked = bankIN.filter((b) => !b.linkCount);
P(`\n=== cartola IN sin conciliar: ${inUnlinked.length} / ${bankIN.length} ===`);
const tbkAbono = inUnlinked.filter((b) => /ABN CRD|TRANSBA/i.test(b.description || "")).length;
P(`  de esos, abonos Transbank (glosa ABN CRD/TRANSBA): ${tbkAbono}`);
