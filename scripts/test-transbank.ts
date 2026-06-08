import { parseTransbankAbonos } from "../src/lib/transbank/parse-abonos";
import { readFileSync } from "fs";
import { resolve } from "path";

const file = resolve(process.cwd(), "dump", "Abonos_por_día.xls");
const parsed = parseTransbankAbonos(readFileSync(file));
console.log("empresaRut:", parsed.empresaRut, "| cuentaAbono:", parsed.cuentaAbono);
console.log("periodo:", parsed.periodFrom?.toISOString().slice(0, 10), "->", parsed.periodTo?.toISOString().slice(0, 10));
console.log("ventas:", parsed.sales.length, "| errores:", parsed.errors.length, JSON.stringify(parsed.errors.slice(0, 3)));
for (const s of parsed.sales.slice(0, 6)) {
  console.log(`  ${s.fechaVenta.toISOString().slice(0, 10)} "${s.nombreLocal}" bruto=${s.montoVenta} com=${s.comision} neto=${s.totalAbono} boleta=${s.numeroBoleta} uniq=${s.numeroUnico} medio=${s.medioPago}`);
}

const re = /\b(?:N\s*OPE|OPE|OP|NO|TD\s*OP|TCKT|TKT)[\s.:#]*0*(\d{2,7})/g;
function op(g: string): string | null {
  const G = g.toUpperCase();
  let m: RegExpExecArray | null, last: string | null = null;
  while ((m = re.exec(G)) !== null) last = m[1];
  re.lastIndex = 0;
  if (last) return last.replace(/^0+/, "") || last;
  const n = G.match(/\d{2,7}/g);
  return n ? n[n.length - 1].replace(/^0+/, "") : null;
}
console.log("\nOP extractor:");
for (const g of ["OP3958", "OP:003957", "VTA. TBK. DBTO. OP. 3922", "N OPE 3931", "NO 003919", "GIRO 13370 N OPE 3932", "TD OP03901", "ENVIO APP. TCKT. 3941"]) {
  console.log(`  "${g}" -> ${op(g)}`);
}
