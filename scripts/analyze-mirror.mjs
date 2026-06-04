/**
 * Analisis preparatorio del matching OUT ↔ IN para "Traspasos internos".
 *
 * Sobre el dump de OUTs, mira:
 *   - Cuantos OUTs internos hay por entidad destino.
 *   - Si hay varios OUTs el mismo dia con mismo monto a la misma entidad
 *     (= ambiguedad: el matcher no sabra cual IN corresponde a cual OUT).
 *   - Que cuentas origen mandan a que entidades destino (mapa source -> dest).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const CSV = resolve(process.cwd(), "dumps/egresos_out_2026-06-04.csv");

const INTERNOS = [
  { rut: "77.333.097-2", canon: "MG" },
  { rut: "77.333.096-4", canon: "ME" },
  { rut: "77.333.099-9", canon: "More Giros" },
  { rut: "76.815.928-9", canon: "More Capital" },
  { rut: "76.611.709-0", canon: "More Exchange" },
  { rut: "78.026.624-4", canon: "Baco SPA" },
];

function normRut(s) {
  if (!s) return "";
  return String(s).replace(/[^0-9kK]/g, "").toUpperCase();
}
function matchRut(a, b) {
  if (!a || !b) return false;
  const ax = a.replace(/^0+/, "");
  const bx = b.replace(/^0+/, "");
  if (ax === bx) return true;
  if (ax.length >= 7 && bx.startsWith(ax)) return true;
  if (bx.length >= 7 && ax.startsWith(bx)) return true;
  return false;
}
function extractRut(text) {
  if (!text) return "";
  const t = String(text);
  const formal = t.match(/(\d{1,2}\.?\d{3}\.?\d{3}-[\dkK])/);
  if (formal) return normRut(formal[1]);
  const prefix = t.match(/^(\d{8,11})\b/);
  if (prefix) return normRut(prefix[1]);
  return "";
}
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let i = 0, field = "", row = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const raw = readFileSync(CSV, "utf8");
const rows = parseCsv(raw);
const header = rows.shift();
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const internosNorm = INTERNOS.map((x) => ({ ...x, rutNorm: normRut(x.rut) }));
const byRut = new Map(internosNorm.map((x) => [x.rutNorm, x]));

// Para cada OUT interno, registramos: (sourceAccountId, destEntityCanon, date, amount).
const outs = [];
for (const r of rows) {
  const rut = normRut(r[idx.counterpartyRut]);
  const desc = r[idx.description] || "";
  const name = r[idx.counterpartyName] || "";
  let entityRut = null;
  if (rut) {
    for (const e of internosNorm) if (matchRut(rut, e.rutNorm)) { entityRut = e; break; }
  }
  if (!entityRut) {
    const rutInName = extractRut(name);
    if (rutInName) for (const e of internosNorm) if (matchRut(rutInName, e.rutNorm)) { entityRut = e; break; }
  }
  if (!entityRut) {
    const rutInDesc = extractRut(desc);
    if (rutInDesc) for (const e of internosNorm) if (matchRut(rutInDesc, e.rutNorm)) { entityRut = e; break; }
  }
  if (!entityRut) continue;

  outs.push({
    sourceAccount: `${r[idx.bankCode]} · ${r[idx.accountAlias] || r[idx.accountNumber]}`,
    sourceAccountId: r[idx.accountId],
    destEntity: entityRut.canon,
    destRut: entityRut.rut,
    date: r[idx.postDate],
    amount: r[idx.amount],
    description: desc,
  });
}

const hr = "=".repeat(72);
console.log(hr);
console.log("ANALISIS PREPARATORIO — traspasos internos");
console.log(hr);
console.log(`OUTs internos detectados (cualquier via): ${outs.length}`);
console.log("");

// 1) Distribucion: source → dest
console.log("1) Origen → Destino (cuantos OUTs van de cada cuenta a cada entidad)\n");
const pairCount = new Map();
for (const o of outs) {
  const k = `${o.sourceAccount}  →  ${o.destEntity}`;
  pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
}
for (const [k, c] of [...pairCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${k}`);
}

// 2) Ambiguedad: ¿hay varios OUTs el mismo dia con el mismo monto a la misma entidad?
console.log("\n2) Posible ambiguedad: varios OUTs con misma fecha + monto + destino\n");
const groupKey = (o) => `${o.date}|${o.amount}|${o.destEntity}`;
const groups = new Map();
for (const o of outs) {
  const k = groupKey(o);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(o);
}
const ambiguous = [...groups.values()].filter((arr) => arr.length > 1);
if (ambiguous.length === 0) {
  console.log("  Ninguno. Todos los OUTs son unicos por (fecha, monto, destino) →");
  console.log("  el matcher 1:1 contra el IN espejo no va a tener ambiguedad por este lado.");
} else {
  console.log(`  ${ambiguous.length} grupo(s) ambiguo(s):`);
  for (const arr of ambiguous) {
    console.log(`    ${arr.length}× ${arr[0].date}  $${arr[0].amount}  → ${arr[0].destEntity}`);
    for (const o of arr) console.log(`        desde ${o.sourceAccount}`);
  }
}

// 3) Entidades destino que esperariamos tener como cuenta propia
console.log("\n3) Entidades destino que aparecen — para que el matcher exista, debe haber");
console.log("   al menos una BankAccount con holderRut == este RUT en el sistema:\n");
const destSet = new Map();
for (const o of outs) {
  const e = destSet.get(o.destEntity) || { count: 0, rut: o.destRut };
  e.count++;
  destSet.set(o.destEntity, e);
}
for (const [canon, e] of [...destSet.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(e.count).padStart(4)}  ${canon.padEnd(20)} (RUT ${e.rut})`);
}

console.log("");
console.log(hr);
console.log("NOTA: el dump tiene solo OUTs. Para verificar que existe el IN espejo");
console.log("hay que correr el matcher en la BD real (donde estan ambos lados).");
console.log(hr);
