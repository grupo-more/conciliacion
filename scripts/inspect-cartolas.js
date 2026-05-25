const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const DIR = path.resolve(__dirname, "..", "cartola");

const files = fs.readdirSync(DIR).filter((f) => /\.(xlsx?|XLSX?)$/.test(f));

for (const file of files) {
  console.log("\n" + "=".repeat(80));
  console.log("ARCHIVO:", file);
  console.log("=".repeat(80));

  const full = path.join(DIR, file);
  let wb;
  try {
    wb = XLSX.readFile(full, { cellDates: true });
  } catch (e) {
    console.log("  ERROR al leer:", e.message);
    continue;
  }

  console.log("Hojas:", wb.SheetNames);

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;

    console.log(`\n  --- Hoja "${sheetName}" (${totalRows} filas x ${totalCols} columnas) ---`);

    const aoa = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
      raw: false,
    });

    const preview = aoa.slice(0, 18);
    preview.forEach((row, idx) => {
      const r = (row || []).map((c) => {
        if (c === null || c === undefined) return "";
        const s = String(c);
        return s.length > 40 ? s.slice(0, 37) + "..." : s;
      });
      console.log(`    [${String(idx + 1).padStart(3, "0")}]`, r.join(" | "));
    });

    if (aoa.length > 18) {
      console.log(`    ... (${aoa.length - 18} filas más)`);
    }
  }
}
