/**
 * Diagnóstico: ¿por qué hay abonos Transbank (TransbankSale) con montoVenta = 0?
 *
 * Imprime, para cada fila con bruto 0, el tipo de movimiento, medio de pago,
 * neto (totalAbono) y la fila CRUDA del .xls (rawRow) tal cual se importó.
 * Así vemos si el archivo original ya traía "monto original de venta" vacío/0
 * (dato del proveedor) o si se está leyendo mal una columna (bug de parseo).
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/diag-bruto-cero.ts
 */

import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  try {
    const ceros = await prisma.transbankSale.findMany({
      where: { montoVenta: 0n },
      orderBy: { fechaVenta: "desc" },
      take: 40,
    });
    const total = await prisma.transbankSale.count();
    const totalCeros = await prisma.transbankSale.count({ where: { montoVenta: 0n } });

    console.log(`TransbankSale totales: ${total}`);
    console.log(`Con montoVenta = 0:   ${totalCeros}`);
    console.log("=".repeat(80));

    for (const s of ceros) {
      console.log(
        `\n${s.fechaVenta.toISOString().slice(0, 10)} | tipo="${s.tipoMovimiento}" | medio="${s.medioPago}" | ` +
        `boleta=${s.numeroBoleta ?? "—"} | bruto=${s.montoVenta} | comision=${s.comision} | neto=${s.totalAbono} | local="${s.nombreLocal}"`,
      );
      // Fila cruda del Excel: muestra qué decía CADA columna del archivo original.
      const raw = s.rawRow as Record<string, unknown> | null;
      if (raw) {
        for (const [k, v] of Object.entries(raw)) {
          if (v === null || v === "") continue;
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
