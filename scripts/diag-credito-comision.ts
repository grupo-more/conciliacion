/**
 * Análisis: ¿qué distingue a las ventas Crédito con comisión $0 de las Crédito
 * normales (con ~2%)? Compara ambos grupos campo por campo (sobre la fila cruda
 * del .xls) para entender si son un tipo de registro distinto, comisión diferida,
 * o un dato a filtrar.
 *
 * Uso (EN EL SERVER):
 *   npx tsx scripts/diag-credito-comision.ts
 */

import { PrismaClient } from "@prisma/client";

// Campos crudos del .xls que pueden distinguir un tipo de registro de otro.
const CAMPOS = [
  "Tipo de movimiento",
  "Tipo de venta/cuota",
  "N° de cuota",
  "N° de boleta",
  "Período de cobro",
  "ID de servicio",
  "Código de autorización de venta",
  "ID transacción (TID)",
  "Monto original de venta (+)",
  "Monto venta válido para abono (+)",
  "Comisión Transbank (-)",
  "Total abono (=)",
];

function dist(rows: Array<Record<string, unknown> | null>, campo: string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const raw = r ? r[campo] : null;
    // Para los montos, agrupamos por "= 0" vs "> 0" en vez del valor exacto.
    let key = raw === null || raw === undefined ? "(vacío)" : String(raw).trim();
    if (campo.startsWith("Monto") || campo.startsWith("Total") || campo.startsWith("Comisión")) {
      const n = Number(String(raw).replace(/[^0-9.-]/g, "")) || 0;
      key = n === 0 ? "= 0" : "> 0";
    }
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const credito = await prisma.transbankSale.findMany({
      where: { medioPago: { contains: "rédito" } },
      select: { comision: true, ivaComision: true, montoVenta: true, totalAbono: true, numeroBoleta: true, rawRow: true },
    });

    const sinCom = credito.filter((s) => s.comision === 0n && s.ivaComision === 0n);
    const conCom = credito.filter((s) => s.comision !== 0n || s.ivaComision !== 0n);

    console.log(`Crédito total: ${credito.length}`);
    console.log(`  con comisión: ${conCom.length}`);
    console.log(`  comisión $0:  ${sinCom.length}`);
    console.log("=".repeat(70));

    for (const campo of CAMPOS) {
      console.log(`\n### ${campo}`);
      console.log("  [comisión $0]:", JSON.stringify(dist(sinCom.map((s) => s.rawRow as Record<string, unknown>), campo)));
      console.log("  [con comisión]:", JSON.stringify(dist(conCom.map((s) => s.rawRow as Record<string, unknown>), campo)));
    }

    // ¿Las de comisión $0 tienen boleta? ¿bruto venía 0 en la columna estándar?
    const sinComConBoleta = sinCom.filter((s) => s.numeroBoleta).length;
    console.log("\n" + "=".repeat(70));
    console.log(`Comisión $0 que SÍ tienen boleta: ${sinComConBoleta} / ${sinCom.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
