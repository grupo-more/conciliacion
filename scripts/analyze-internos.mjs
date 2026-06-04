/**
 * Análisis one-shot del CSV de egresos: cruza contra los 6 RUTs internos
 * conocidos y reporta variantes de nombre + matches "huérfanos" por nombre
 * (filas que parecen internas pero no traen RUT).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const CSV = resolve(process.cwd(), "dumps/egresos_out_2026-06-04.csv");

// RUTs internos conocidos (lo que pasó Diego).
const INTERNOS = [
  { rut: "77.333.097-2", canon: "MG",            rubro: 198, hints: ["mg"] },
  { rut: "77.333.096-4", canon: "ME",            rubro: 197, hints: ["me"] },
  { rut: "77.333.099-9", canon: "More Giros",    rubro: null, hints: ["more giros", "m.giros", "m giros", "moregiros"] },
  { rut: "76.815.928-9", canon: "More Capital",  rubro: null, hints: ["m.capital", "m capital", "more capital", "morecapital"] },
  { rut: "76.611.709-0", canon: "More Exchange", rubro: null, hints: ["more exchange", "moreexchange"] },
  { rut: "78.026.624-4", canon: "Baco SPA",      rubro: null, hints: ["baco"] },
];

// ---- helpers ----

function normRut(s) {
  if (!s) return "";
  return String(s).replace(/[^0-9kK]/g, "").toUpperCase();
}
function normName(s) {
  if (!s) return "";
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

// CSV parser que soporta campos quoted con comas y comillas escapadas.
function parseCsv(text) {
  // Strip BOM si lo trae.
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

// ---- main ----

const raw = readFileSync(CSV, "utf8");
const rows = parseCsv(raw);
const header = rows.shift();
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const total = rows.length;
const internosNorm = INTERNOS.map((x) => ({ ...x, rutNorm: normRut(x.rut) }));
const byRut = new Map(internosNorm.map((x) => [x.rutNorm, x]));

// Tres baldes:
// 1) match por RUT → variantes de nombre que aparecen junto a ese RUT.
// 2) sin RUT, pero nombre matchea hint → "huérfanos por nombre" sospechosos.
// 3) con RUT no interno → control (no se reporta a menos que coincida nombre con hint).

const variantsByEntity = new Map(); // canon → Map<nameLower, { name, count }>
const orphansByEntity = new Map();  // canon → Map<nameLower, { name, count, samples:[] }>
const ambiguous = [];               // RUT no interno PERO nombre matchea hint → sospechosos
let rowsConRut = 0, rowsConRutInterno = 0, rowsSinRut = 0, rowsSinRutNiNombre = 0;
const allDistinctNames = new Map(); // global, por si después queremos otro corte

for (const r of rows) {
  const rutRaw = r[idx.counterpartyRut] || "";
  const nameRaw = r[idx.counterpartyName] || "";
  const rut = normRut(rutRaw);
  const name = normName(nameRaw);

  if (name) {
    const e = allDistinctNames.get(name) || { name: nameRaw.trim(), count: 0 };
    e.count++;
    allDistinctNames.set(name, e);
  }

  if (rut) {
    rowsConRut++;
    const hit = byRut.get(rut);
    if (hit) {
      rowsConRutInterno++;
      if (!variantsByEntity.has(hit.canon)) variantsByEntity.set(hit.canon, new Map());
      const m = variantsByEntity.get(hit.canon);
      const key = name || "(sin nombre)";
      const e = m.get(key) || { name: name ? nameRaw.trim() : "(sin nombre)", count: 0 };
      e.count++;
      m.set(key, e);
    } else if (name) {
      // RUT no interno pero el nombre podría sonar a interno → flagear.
      for (const x of internosNorm) {
        if (x.hints.some((h) => name.includes(h))) {
          ambiguous.push({ canon: x.canon, name: nameRaw.trim(), rut: rutRaw, count: 1 });
          break;
        }
      }
    }
  } else {
    rowsSinRut++;
    if (!name) {
      rowsSinRutNiNombre++;
      continue;
    }
    // sin RUT — ver si nombre matchea algún hint
    for (const x of internosNorm) {
      if (x.hints.some((h) => name.includes(h))) {
        if (!orphansByEntity.has(x.canon)) orphansByEntity.set(x.canon, new Map());
        const m = orphansByEntity.get(x.canon);
        const e = m.get(name) || { name: nameRaw.trim(), count: 0, samples: [] };
        e.count++;
        if (e.samples.length < 3) e.samples.push(r[idx.description] || "");
        m.set(name, e);
        break;
      }
    }
  }
}

// ---- print ----

const hr = "=".repeat(72);
console.log(hr);
console.log("ANÁLISIS DE EGRESOS INTERNOS — variantes de nombre por RUT");
console.log(hr);
console.log(`Total egresos OUT analizados: ${total}`);
console.log(`  con RUT:                 ${rowsConRut}  (${pct(rowsConRut, total)}%)`);
console.log(`    └ con RUT INTERNO:     ${rowsConRutInterno}  (${pct(rowsConRutInterno, total)}%)`);
console.log(`  sin RUT, con nombre:     ${rowsSinRut - rowsSinRutNiNombre}  (${pct(rowsSinRut - rowsSinRutNiNombre, total)}%)`);
console.log(`  sin RUT ni nombre:       ${rowsSinRutNiNombre}  (${pct(rowsSinRutNiNombre, total)}%)`);
console.log("");

console.log(hr);
console.log("1) VARIANTES DE NOMBRE OBSERVADAS POR RUT INTERNO");
console.log(hr);
for (const x of internosNorm) {
  const m = variantsByEntity.get(x.canon);
  const rubroStr = x.rubro != null ? ` · rubro ${x.rubro}` : "";
  console.log(`\n[${x.canon}]  ${x.rut}${rubroStr}`);
  if (!m || m.size === 0) {
    console.log("  (sin egresos con este RUT en el rango)");
    continue;
  }
  const variants = [...m.values()].sort((a, b) => b.count - a.count);
  const totalRut = variants.reduce((acc, v) => acc + v.count, 0);
  console.log(`  ${totalRut} egresos · ${variants.length} variante(s) de nombre:`);
  for (const v of variants) {
    console.log(`    ${String(v.count).padStart(4)} × "${v.name}"`);
  }
}

console.log("\n" + hr);
console.log("2) HUÉRFANOS POR NOMBRE — filas SIN RUT cuyo nombre matchea un hint");
console.log(hr);
console.log("(Probablemente internos pero el banco no trajo el RUT)");
let totalHuerfanos = 0;
for (const x of internosNorm) {
  const m = orphansByEntity.get(x.canon);
  if (!m || m.size === 0) continue;
  console.log(`\n[${x.canon}]  hint(s): ${x.hints.join(", ")}`);
  const variants = [...m.values()].sort((a, b) => b.count - a.count);
  const totalRut = variants.reduce((acc, v) => acc + v.count, 0);
  totalHuerfanos += totalRut;
  console.log(`  ${totalRut} egresos huérfanos · ${variants.length} variante(s):`);
  for (const v of variants) {
    console.log(`    ${String(v.count).padStart(4)} × "${v.name}"`);
    if (v.samples[0]) console.log(`         glosa: "${v.samples[0].slice(0, 80)}"`);
  }
}
if (totalHuerfanos === 0) {
  console.log("\n  (ninguna fila huérfana cae en los hints conocidos)");
} else {
  console.log(`\n  TOTAL huérfanos potencialmente internos: ${totalHuerfanos}`);
}

if (ambiguous.length > 0) {
  console.log("\n" + hr);
  console.log("3) AMBIGUOS — RUT NO interno PERO nombre suena a interno");
  console.log(hr);
  console.log("(Revisar uno por uno: o falta agregar ese RUT, o el nombre coincide por casualidad)");
  const grouped = new Map();
  for (const a of ambiguous) {
    const k = `${a.canon}|${a.rut}|${a.name}`;
    const e = grouped.get(k) || { ...a, count: 0 };
    e.count++;
    grouped.set(k, e);
  }
  for (const a of [...grouped.values()].sort((x, y) => y.count - x.count)) {
    console.log(`  ${String(a.count).padStart(3)} × rut=${a.rut}  name="${a.name}"  → suena a ${a.canon}`);
  }
}

console.log("");

function pct(n, t) { return t === 0 ? "0.0" : ((n / t) * 100).toFixed(1); }
