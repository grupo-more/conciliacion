/**
 * Backfill del bruto (montoVenta) para los abonos Transbank ya importados donde
 * quedó en $0. En ventas a crédito Transbank deja "Monto original de venta (+)"
 * en $0 y pone el monto real en "Monto venta válido para abono (+)". El parser ya
 * usa ese fallback para importaciones nuevas; este script corrige las viejas
 * leyendo el valor desde la fila cruda (rawRow) que ya está guardada.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/backfill-bruto-credito.ts          # dry-run, solo reporta
 *   npx tsx scripts/backfill-bruto-credito.ts --apply  # escribe los cambios
 */

import { PrismaClient } from "@prisma/client";
import { parseNum } from "../src/lib/transbank/parse-abonos";

const apply = process.argv.includes("--apply");
const KEY = "Monto venta válido para abono (+)";

async function main() {
  const prisma = new PrismaClient();
  try {
    const ceros = await prisma.transbankSale.findMany({
      where: { montoVenta: 0n },
      select: { id: true, fechaVenta: true, nombreLocal: true, totalAbono: true, rawRow: true },
    });

    const changes: Array<{ id: string; nuevo: number; neto: string; local: string; fecha: string }> = [];
    for (const s of ceros) {
      const raw = s.rawRow as Record<string, unknown> | null;
      const valido = raw ? parseNum(raw[KEY]) : 0;
      if (valido > 0) {
        changes.push({
          id: s.id,
          nuevo: valido,
          neto: s.totalAbono.toString(),
          local: s.nombreLocal,
          fecha: s.fechaVenta.toISOString().slice(0, 10),
        });
      }
    }

    console.log(`Abonos con bruto 0: ${ceros.length}`);
    console.log(`Corregibles (tienen "${KEY}"): ${changes.length}`);
    for (const c of changes) {
      console.log(`  ${c.fecha} | ${c.local} | bruto 0 → ${c.nuevo} | neto ${c.neto}`);
    }

    if (!apply) {
      console.log("\nDRY-RUN. Re-ejecutá con --apply para escribir los cambios.");
      return;
    }

    let updated = 0;
    for (const c of changes) {
      await prisma.transbankSale.update({
        where: { id: c.id },
        data: { montoVenta: BigInt(c.nuevo) },
      });
      updated++;
    }
    console.log(`\nActualizadas ${updated} filas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
