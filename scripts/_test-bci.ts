import * as XLSX from "xlsx";
import { PARSERS } from "../src/lib/cartolas/parsers";

const path = process.argv[2];
const wb = XLSX.readFile(path, { raw: false });

for (const p of PARSERS) {
  let m = false;
  try {
    m = p.matches(wb);
  } catch (e) {
    console.log(`${p.code}: matches() threw: ${(e as Error).message}`);
  }
  console.log(`${p.code}: matches=${m}`);
  if (m) {
    try {
      const res = p.parse(wb);
      console.log(`  → movements=${res.movements.length} errors=${res.errors.length}`);
      console.log(`  → periodFrom=${res.periodFrom} periodTo=${res.periodTo}`);
      console.log(`  → account=`, res.account);
      console.log("  → primeras 3 errors:", JSON.stringify(res.errors.slice(0, 3), null, 2));
      console.log("  → primeros 2 movs:", JSON.stringify(res.movements.slice(0, 2), null, 2));
    } catch (e) {
      console.log(`  parse() threw: ${(e as Error).message}`);
    }
    break;
  }
}
