/**
 * Back-fill del campo cashierName en DynatechMovement.
 *
 * Recorre todos los movimientos con cashierName=null y extrae el nombre desde
 * rawJson.contexto.cajero.nombre. Útil después de agregar el campo cuando ya
 * tienes data sin el nombre poblado.
 */
import { prisma } from "../src/lib/db";

async function main() {
  const total = await prisma.dynatechMovement.count();
  const missing = await prisma.dynatechMovement.findMany({
    where: { cashierName: null },
    select: { id: true, cashierUsername: true, rawJson: true },
  });

  console.log(`Total movimientos: ${total}`);
  console.log(`Sin cashierName:   ${missing.length}`);

  let updated = 0;
  let skipped = 0;
  const namesByUsername = new Map<string, string>();

  for (const m of missing) {
    const raw = m.rawJson as { contexto?: { cajero?: { nombre?: string } } } | null;
    const nombre = raw?.contexto?.cajero?.nombre?.trim();
    if (nombre) {
      await prisma.dynatechMovement.update({
        where: { id: m.id },
        data: { cashierName: nombre },
      });
      namesByUsername.set(m.cashierUsername, nombre);
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`Actualizados: ${updated}`);
  console.log(`Sin nombre en rawJson: ${skipped}`);

  if (namesByUsername.size > 0) {
    console.log(`\nMapeo username → nombre:`);
    for (const [u, n] of namesByUsername.entries()) {
      console.log(`  ${u.padEnd(20)} → ${n}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
