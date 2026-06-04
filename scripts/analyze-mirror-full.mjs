/**
 * Analisis completo del matching espejo OUT ↔ IN entre cuentas internas.
 *
 * Sobre el dump IN+OUT, busca para cada OUT detectado como interno:
 *   - candidatos IN en otra cuenta nuestra con mismo monto absoluto, fecha
 *     dentro de ventana, y holderRut de la cuenta destino == entidad detectada.
 *
 * Reporta 4 baldes:
 *   - 1:1 limpio
 *   - 1:N ambiguo (1 OUT, varios INs candidatos)
 *   - OUT huerfano (0 candidatos)
 *   - IN huerfano (INs internos sin OUT candidato)
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const CSV = resolve(process.cwd(), "dumps/movimientos_all_2026-06-04.csv");
const DATE_WINDOW_DAYS = 2; // ventana ±2 dias entre OUT y IN

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
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function aliasRegex(alias) {
  const escaped = escapeRegex(alias.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`, "i");
}

const ENTIDAD_ALIASES = {
  MG: ["MG SPA"],
  ME: ["ME SPA", "Me Spa"],
  "More Giros": ["More Giros", "M.Giros", "MoreGiros"],
  "More Capital": ["More Capital Spa", "MORE CAPITAL S", "MoreCapital"],
  "More Exchange": ["More Exchange", "MoreExchange"],
  "Baco SPA": ["Baco SPA", "Baco"],
};

function detectInterno(m, internos) {
  const rut = normRut(m.counterpartyRut);
  if (rut) {
    for (const e of internos) if (matchRut(rut, e.rutNorm)) return { entidad: e, via: "rut" };
  }
  const rIn = extractRut(m.counterpartyName);
  if (rIn) for (const e of internos) if (matchRut(rIn, e.rutNorm)) return { entidad: e, via: "rut_in_name" };
  const rD = extractRut(m.description);
  if (rD) for (const e of internos) if (matchRut(rD, e.rutNorm)) return { entidad: e, via: "rut_in_desc" };
  const name = (m.counterpartyName ?? "").trim();
  if (name) {
    for (const e of internos) {
      for (const a of ENTIDAD_ALIASES[e.canon] || []) {
        if (aliasRegex(a).test(name)) return { entidad: e, via: "alias" };
      }
    }
  }
  return null;
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

// --- Carga ---

const raw = readFileSync(CSV, "utf8");
const rows = parseCsv(raw);
const header = rows.shift();
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const internosNorm = INTERNOS.map((x) => ({ ...x, rutNorm: normRut(x.rut) }));

// Mapa accountId → info de cuenta (con holderRut normalizado).
const accountInfo = new Map();
for (const r of rows) {
  const aid = r[idx.accountId];
  if (!accountInfo.has(aid)) {
    accountInfo.set(aid, {
      bankCode: r[idx.bankCode],
      accountNumber: r[idx.accountNumber],
      holderName: r[idx.holderName],
      holderRut: r[idx.holderRut],
      holderRutNorm: normRut(r[idx.holderRut]),
    });
  }
}

// Mapa rutCanonico-de-entidad-interna → lista de cuentas nuestras con ese holderRut.
// (Asi sabemos cuales cuentas nuestras pertenecen a cada entidad interna.)
const accountsByEntityRut = new Map();
for (const [aid, info] of accountInfo) {
  if (!info.holderRutNorm) continue;
  for (const e of internosNorm) {
    if (matchRut(info.holderRutNorm, e.rutNorm)) {
      if (!accountsByEntityRut.has(e.canon)) accountsByEntityRut.set(e.canon, []);
      accountsByEntityRut.get(e.canon).push({ id: aid, ...info });
    }
  }
}

// --- Clasifico cada fila ---

const movements = rows.map((r) => ({
  id: r[idx.id],
  accountId: r[idx.accountId],
  postDate: r[idx.postDate],
  amount: BigInt(r[idx.amount]),
  amountAbs: BigInt(r[idx.amount]) < 0n ? -BigInt(r[idx.amount]) : BigInt(r[idx.amount]),
  direction: r[idx.direction],
  description: r[idx.description],
  counterpartyName: r[idx.counterpartyName],
  counterpartyRut: r[idx.counterpartyRut],
  bankCode: r[idx.bankCode],
}));

const outsInternal = [];
const insInternal = [];

for (const m of movements) {
  const det = detectInterno(m, internosNorm);
  if (!det) continue;
  if (m.direction === "OUT") {
    outsInternal.push({ ...m, entidad: det.entidad.canon, entidadRut: det.entidad.rutNorm, via: det.via });
  } else if (m.direction === "IN") {
    insInternal.push({ ...m, entidad: det.entidad.canon, entidadRut: det.entidad.rutNorm, via: det.via });
  }
}

// --- Matching OUT → IN candidatos ---

function dateDiffDays(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

const matchResults = { clean: [], ambig: [], orphan: [] };

for (const o of outsInternal) {
  // Cuentas nuestras que pertenecen a la entidad destino del OUT.
  const destAccounts = accountsByEntityRut.get(o.entidad) || [];
  const destAccountIds = new Set(destAccounts.map((a) => a.id));

  // INs candidatos.
  const candidates = movements.filter((m) =>
    m.direction === "IN" &&
    destAccountIds.has(m.accountId) &&
    m.amountAbs === o.amountAbs &&
    dateDiffDays(m.postDate, o.postDate) <= DATE_WINDOW_DAYS
  );

  if (candidates.length === 0) matchResults.orphan.push({ out: o, reason: destAccounts.length === 0 ? "no-dest-account" : "no-amount-date-match" });
  else if (candidates.length === 1) matchResults.clean.push({ out: o, in: candidates[0] });
  else matchResults.ambig.push({ out: o, candidates });
}

// --- INs internos que NO se usaron como espejo de ningun OUT ---

const usedInIds = new Set();
for (const m of matchResults.clean) usedInIds.add(m.in.id);
for (const m of matchResults.ambig) for (const c of m.candidates) usedInIds.add(c.id);

const inOrphans = insInternal.filter((i) => !usedInIds.has(i.id));

// --- Report ---

const hr = "=".repeat(72);
console.log(hr);
console.log("ANALISIS COMPLETO — Traspasos internos: matching OUT ↔ IN espejo");
console.log(hr);
console.log(`Total movimientos en el dump:    ${movements.length}`);
console.log(`  IN:                            ${movements.filter((m) => m.direction === "IN").length}`);
console.log(`  OUT:                           ${movements.filter((m) => m.direction === "OUT").length}`);
console.log("");
console.log(`OUTs detectados como internos:   ${outsInternal.length}`);
console.log(`INs detectados como internos:    ${insInternal.length}`);
console.log("");
console.log(`Cuentas nuestras por entidad (segun holderRut en el dump):`);
for (const [canon, accs] of accountsByEntityRut) {
  console.log(`  ${canon.padEnd(18)} → ${accs.length} cuenta(s)`);
  for (const a of accs) console.log(`      · ${a.bankCode} ${a.accountNumber} (${a.holderName})`);
}
// Entidades sin cuenta destino en el dump
for (const e of internosNorm) {
  if (!accountsByEntityRut.has(e.canon)) {
    console.log(`  ${e.canon.padEnd(18)} → 0 cuentas (no podemos matchear sus INs)`);
  }
}
console.log("");

console.log(hr);
console.log("RESULTADO DEL MATCHING OUT → IN espejo");
console.log(hr);
console.log(`Match 1:1 limpio:        ${matchResults.clean.length}  (${pct(matchResults.clean.length, outsInternal.length)}%)`);
console.log(`Match 1:N ambiguo:       ${matchResults.ambig.length}  (${pct(matchResults.ambig.length, outsInternal.length)}%)`);
console.log(`OUT huerfano (0 IN):     ${matchResults.orphan.length}  (${pct(matchResults.orphan.length, outsInternal.length)}%)`);
console.log("");

// Breakdown de huerfanos por razon
const orphansByReason = {};
for (const o of matchResults.orphan) {
  orphansByReason[o.reason] = (orphansByReason[o.reason] ?? 0) + 1;
}
console.log("OUT huerfanos por razon:");
for (const [reason, c] of Object.entries(orphansByReason)) {
  const label = reason === "no-dest-account"
    ? "no tenemos cuenta destino cargada para esa entidad"
    : "tenemos cuenta destino pero no aparece IN matcheable";
  console.log(`  ${String(c).padStart(4)}  ${reason.padEnd(22)} (${label})`);
}
console.log("");

// Breakdown de ambiguos por (entidad destino + #candidatos)
console.log("Ambiguos — distribucion de #candidatos por OUT:");
const ambigBucket = {};
for (const a of matchResults.ambig) {
  const k = a.candidates.length;
  ambigBucket[k] = (ambigBucket[k] ?? 0) + 1;
}
for (const [n, c] of Object.entries(ambigBucket).sort((a, b) => +a[0] - +b[0])) {
  console.log(`  ${String(c).padStart(4)}  OUTs con ${n} INs candidatos`);
}
console.log("");

// Top entidades con mas matches limpios
console.log("Matches limpios por entidad destino:");
const cleanByEntity = {};
for (const m of matchResults.clean) {
  cleanByEntity[m.out.entidad] = (cleanByEntity[m.out.entidad] ?? 0) + 1;
}
for (const [e, c] of Object.entries(cleanByEntity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${e}`);
}
console.log("");

console.log(hr);
console.log(`INs internos huerfanos (sin OUT espejo): ${inOrphans.length}`);
console.log(hr);
console.log("(INs con counterparty interno cuyo OUT no aparecio en la ventana)");
const inOrphansByEntity = {};
for (const i of inOrphans) inOrphansByEntity[i.entidad] = (inOrphansByEntity[i.entidad] ?? 0) + 1;
for (const [e, c] of Object.entries(inOrphansByEntity).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${e}`);
}
console.log("");

// Mostrar algunos ejemplos de ambiguos
if (matchResults.ambig.length > 0) {
  console.log(hr);
  console.log("EJEMPLOS DE AMBIGUOS (primeros 5) — para diseñar la desambiguacion");
  console.log(hr);
  for (const a of matchResults.ambig.slice(0, 5)) {
    const o = a.out;
    const destAccs = accountsByEntityRut.get(o.entidad) || [];
    console.log(`\n  OUT  ${o.postDate}  $${o.amountAbs}  → ${o.entidad}`);
    console.log(`       desde acc=${o.accountId} (${o.bankCode})`);
    console.log(`       desc="${(o.description || "").slice(0, 60)}"`);
    console.log(`       Candidatos IN (${a.candidates.length}):`);
    for (const c of a.candidates.slice(0, 6)) {
      const cAcc = accountInfo.get(c.accountId);
      console.log(`         ${c.postDate}  $${c.amountAbs}  en ${cAcc.bankCode} ${cAcc.accountNumber}`);
      console.log(`           cpName="${(c.counterpartyName || "").slice(0, 40)}"  cpRut="${c.counterpartyRut || "—"}"`);
      console.log(`           desc="${(c.description || "").slice(0, 60)}"`);
    }
  }
  console.log("");
}

// Ejemplos de huerfanos OUT con tipo "no-amount-date-match" (mas interesantes)
const interestingOrphans = matchResults.orphan.filter((o) => o.reason === "no-amount-date-match");
if (interestingOrphans.length > 0) {
  console.log(hr);
  console.log("EJEMPLOS DE OUT HUERFANOS (primeros 5) — la cuenta destino EXISTE pero");
  console.log("no encontramos IN con mismo monto en ±2 dias");
  console.log(hr);
  for (const o of interestingOrphans.slice(0, 5)) {
    const out = o.out;
    console.log(`\n  OUT  ${out.postDate}  $${out.amountAbs}  → ${out.entidad}`);
    console.log(`       desde acc=${out.accountId} (${out.bankCode})`);
    console.log(`       desc="${(out.description || "").slice(0, 60)}"`);
  }
}

function pct(n, t) { return t === 0 ? "0.0" : ((n / t) * 100).toFixed(1); }
