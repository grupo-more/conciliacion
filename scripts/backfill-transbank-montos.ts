/**
 * Backfill de montos mal parseados en TransbankSale.
 *
 * Contexto: el reporte "Abonos por día" llega indistintamente en formato es-CL
 * ("$350.000") y en-US ("$350,000"). El parser viejo asumía es-CL, así que los
 * archivos en formato US quedaron con los montos divididos por ~1000 (ej.
 * "$350,000" → 350). Esto dejó settlements sin cuadrar contra el POS por estar
 * fuera de la tolerancia del 5%.
 *
 * Este script re-deriva los 5 campos de monto (montoVenta, comision,
 * ivaComision, totalAbono, montoAnulado) desde el rawRow YA GUARDADO usando el
 * parseNum corregido. NO requiere re-subir el .xls.
 *
 * Las claves de rawRow conservan el orden de columnas del archivo
 * (header.forEach al importar), así que replicamos el findCol del parser:
 * primer header que contiene el needle = misma columna que eligió el import.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/backfill-transbank-montos.ts            # dry-run (no escribe)
 *   npx tsx scripts/backfill-transbank-montos.ts --apply    # aplica los cambios
 */

import { PrismaClient } from "@prisma/client";
import { parseNum } from "@/lib/transbank/parse-abonos";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

/** Valor de la primera columna del rawRow cuyo header contiene algún needle. */
function colVal(rr: Record<string, unknown>, ...needles: string[]): unknown {
  const keys = Object.keys(rr);
  for (const n of needles) {
    const k = keys.find((key) => key.toLowerCase().includes(n.toLowerCase()));
    if (k) return rr[k];
  }
  return "";
}

function derive(rr: Record<string, unknown>) {
  return {
    montoVenta: BigInt(parseNum(colVal(rr, "monto original de venta"))),
    comision: BigInt(parseNum(colVal(rr, "comisión transbank (-)", "comision transbank (-)"))),
    ivaComision: BigInt(parseNum(colVal(rr, "iva comisión transbank", "iva comision transbank"))),
    totalAbono: BigInt(parseNum(colVal(rr, "total abono"))),
    montoAnulado: BigInt(parseNum(colVal(rr, "monto anulado"))),
  };
}

async function main() {
  const sales = await prisma.transbankSale.findMany();
  console.log(`Revisando ${sales.length} settlements...`);

  let changed = 0;
  const ejemplos: string[] = [];

  for (const s of sales) {
    const rr = (s.rawRow ?? {}) as Record<string, unknown>;
    if (!rr || Object.keys(rr).length === 0) continue;
    const next = derive(rr);

    const diff =
      next.montoVenta !== s.montoVenta ||
      next.comision !== s.comision ||
      next.ivaComision !== s.ivaComision ||
      next.totalAbono !== s.totalAbono ||
      next.montoAnulado !== s.montoAnulado;
    if (!diff) continue;

    changed++;
    if (ejemplos.length < 12) {
      ejemplos.push(
        `  boleta=${s.numeroBoleta ?? "—"} suc=${s.sucursalId ?? "—"} ` +
          `montoVenta ${s.montoVenta} → ${next.montoVenta} | ` +
          `abono ${s.totalAbono} → ${next.totalAbono}`,
      );
    }

    if (APPLY) {
      await prisma.transbankSale.update({ where: { id: s.id }, data: next });
    }
  }

  console.log("=".repeat(60));
  console.log(`Settlements con monto a corregir: ${changed} de ${sales.length}`);
  if (ejemplos.length) {
    console.log("\nEjemplos:");
    console.log(ejemplos.join("\n"));
  }
  console.log("\n" + (APPLY ? "✅ Cambios APLICADOS." : "🔎 DRY-RUN: no se escribió nada. Corré con --apply para aplicar."));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
