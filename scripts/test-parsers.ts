import * as path from "path";
import * as fs from "fs";
import * as XLSX from "xlsx";
import { detectParser } from "../src/lib/cartolas/detect";
import { computeDedupKeys } from "../src/lib/cartolas/dedup";

const DIR = path.resolve(__dirname, "..", "cartola");
const files = fs.readdirSync(DIR).filter((f) => /\.(xlsx?|XLSX?)$/.test(f));

let okCount = 0;
let failCount = 0;

for (const file of files) {
  const full = path.join(DIR, file);
  console.log("\n" + "=".repeat(90));
  console.log("ARCHIVO:", file);
  console.log("=".repeat(90));

  let wb;
  try {
    wb = XLSX.readFile(full, { cellDates: true });
  } catch (e: any) {
    console.log("  ERROR al leer:", e.message);
    failCount++;
    continue;
  }

  const parser = detectParser(wb);
  if (!parser) {
    console.log("  ❌ Ningún parser reconoció el formato");
    console.log("     Hojas:", wb.SheetNames);
    failCount++;
    continue;
  }

  console.log(`  ✓ Parser: ${parser.code} (${parser.bankName})`);

  let result;
  try {
    result = parser.parse(wb);
  } catch (e: any) {
    console.log("  ❌ Error al parsear:", e.message);
    failCount++;
    continue;
  }

  const periodFromStr = result.periodFrom
    ? result.periodFrom.toISOString().slice(0, 10)
    : "—";
  const periodToStr = result.periodTo
    ? result.periodTo.toISOString().slice(0, 10)
    : "—";

  console.log(`  Cuenta: ${result.account.bankCode} ${result.account.accountNumber}` +
    (result.account.displayNumber ? ` (${result.account.displayNumber})` : ""));
  if (result.account.holderName) {
    console.log(`  Empresa: ${result.account.holderName}` +
      (result.account.holderRut ? ` ${result.account.holderRut}` : ""));
  }
  console.log(`  Periodo: ${periodFromStr} → ${periodToStr}`);
  console.log(`  Movimientos: ${result.movements.length} válidos, ${result.errors.length} con error`);

  if (result.errors.length > 0 && result.errors.length <= 5) {
    console.log(`  Errores:`);
    for (const e of result.errors) {
      console.log(`    fila ${e.rowIndex}: ${e.reason}`);
    }
  } else if (result.errors.length > 5) {
    console.log(`  Errores (primeros 3):`);
    for (const e of result.errors.slice(0, 3)) {
      console.log(`    fila ${e.rowIndex}: ${e.reason}`);
    }
  }

  // Dedup keys
  const keys = computeDedupKeys(result.movements);
  const uniqueKeys = new Set(keys);
  const collisions = keys.length - uniqueKeys.size;
  console.log(`  Dedup: ${uniqueKeys.size} claves únicas` +
    (collisions > 0 ? ` (${collisions} colisiones — REVISAR)` : ""));

  // Mostrar primeros 3 y últimos 2 movimientos
  const sample = [
    ...result.movements.slice(0, 3),
    ...(result.movements.length > 5 ? result.movements.slice(-2) : []),
  ];

  if (sample.length > 0) {
    console.log(`  Muestra:`);
    sample.forEach((m, idx) => {
      const dateStr = m.postDate.toISOString().slice(0, 10);
      const sign = m.amount >= 0 ? "+" : "";
      const desc = m.description.length > 50 ? m.description.slice(0, 47) + "..." : m.description;
      const cp = m.counterpartyName
        ? ` ← ${m.counterpartyName}${m.counterpartyRut ? ` [${m.counterpartyRut}]` : ""}`
        : m.counterpartyRut
        ? ` [${m.counterpartyRut}]`
        : "";
      const ext = m.externalId ? ` ext=${m.externalId}` : "";
      console.log(`    ${dateStr} | ${sign}${m.amount.toLocaleString("es-CL").padStart(14)} | ${desc}${cp}${ext}`);
    });
  }

  okCount++;
}

console.log("\n" + "=".repeat(90));
console.log(`RESUMEN: ${okCount} archivos OK, ${failCount} con problemas (de ${files.length} totales)`);
console.log("=".repeat(90));
