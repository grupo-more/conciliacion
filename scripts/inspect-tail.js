const path = require("path");
const XLSX = require("xlsx");

const f = path.resolve(__dirname, "..", "cartola", "CartolaHistCtaCte-000094050340-0024-20260507.xlsx");
const wb = XLSX.readFile(f, { cellDates: true });
const ws = wb.Sheets["Cartola Historica CtaCte"];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });

// Mostrar filas 90 a 122 (últimas)
console.log("Total filas:", aoa.length);
for (let i = 90; i < aoa.length; i++) {
  const row = (aoa[i] || []).map((c) => (c === null ? "" : String(c).slice(0, 30)));
  console.log(`[${String(i + 1).padStart(3, "0")}]`, row.join(" | "));
}
