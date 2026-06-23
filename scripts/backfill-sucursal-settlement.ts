/**
 * Re-resuelve la sucursal (sucursalId) de los abonos Transbank ya importados
 * (TransbankSale), aplicando la lógica actualizada de resolveSucursal —
 * incluyendo los alias por dirección (VALPARAISO→COCHRANE, PATRONATO→ASUNCION,
 * IQUIQUE→PATRICIO LYNCH, VIÑA DEL MAR→SAN MARTIN).
 *
 * Necesario porque sucursalId se calcula y persiste AL IMPORTAR; las filas viejas
 * quedaron con null y por eso salían como "—" / "(otra)" en el Cruce Transbank.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/backfill-sucursal-settlement.ts          # dry-run, solo reporta
 *   npx tsx scripts/backfill-sucursal-settlement.ts --apply  # escribe los cambios
 */

import { PrismaClient } from "@prisma/client";
import { resolveSucursal } from "../src/lib/transbank/parse-abonos";

const apply = process.argv.includes("--apply");

async function main() {
  const prisma = new PrismaClient();
  try {
    // Mismo catálogo que usa el importador: nombres de sucursal del feed Tesorería.
    const sucRows = await prisma.tesoreriaMovement.groupBy({
      by: ["sucursalId", "sucursalName"],
    });
    const catalog = sucRows
      .filter((r) => r.sucursalName)
      .map((r) => ({ id: r.sucursalId, name: r.sucursalName as string }));

    const sales = await prisma.transbankSale.findMany({
      select: { id: true, nombreLocal: true, sucursalId: true },
    });

    const changes: Array<{ id: string; from: number | null; to: number; nombreLocal: string }> = [];
    for (const s of sales) {
      const resolved = resolveSucursal(s.nombreLocal, catalog);
      if (resolved != null && resolved !== s.sucursalId) {
        changes.push({ id: s.id, from: s.sucursalId, to: resolved, nombreLocal: s.nombreLocal });
      }
    }

    // Resumen por nombreLocal → nuevo sucursalId.
    const byLocal = new Map<string, { to: number; count: number }>();
    for (const c of changes) {
      const k = `${c.nombreLocal} → ${c.to}`;
      const e = byLocal.get(k) ?? { to: c.to, count: 0 };
      e.count++;
      byLocal.set(k, e);
    }
    console.log(`Filas totales: ${sales.length}`);
    console.log(`Filas a re-asignar sucursal: ${changes.length}`);
    for (const [k, v] of [...byLocal.entries()].sort()) console.log(`  ${k}  (${v.count})`);

    if (!apply) {
      console.log("\nDRY-RUN. Re-ejecutá con --apply para escribir los cambios.");
      return;
    }

    // Agrupar por destino para minimizar updates.
    const byTarget = new Map<number, string[]>();
    for (const c of changes) {
      const arr = byTarget.get(c.to) ?? [];
      arr.push(c.id);
      byTarget.set(c.to, arr);
    }
    let updated = 0;
    for (const [sucursalId, ids] of byTarget) {
      const res = await prisma.transbankSale.updateMany({
        where: { id: { in: ids } },
        data: { sucursalId },
      });
      updated += res.count;
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
