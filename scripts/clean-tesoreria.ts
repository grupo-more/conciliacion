/**
 * Limpieza TOTAL del feed "Movimientos 200" (TesoreriaMovement).
 *
 * Borra TODOS los movimientos que entraron por /api/dynatech para reimportarlos
 * limpios desde cero. Pensado para cuando el feed quedó con datos viejos/sucios
 * y querés volver a sincronizar de cero ("que entren limpios de nuevo").
 *
 * CASCADA (no hace falta borrar a mano, el FK lo arrastra):
 *   TesoreriaMovement → Consolidado (onDelete: Cascade)
 *                     → ConsolidadoLink (onDelete: Cascade)
 *
 * Esto BORRA toda la conciliación de los Movimientos 200 (incluyendo los
 * AUTO_MATCHED y MANUAL, y los egresos a terceros que se guardan como
 * Consolidado sobre el EGRESO). Tras correr esto hay que:
 *   1) "Sincronizar ahora" en Movimientos para reimportar el feed.
 *   2) Re-ejecutar el motor de conciliación (Consolidados → run) para
 *      regenerar los matches contra banco.
 *
 * NO toca: TbkTesoreria (17·Transbank), BankMovement/cartolas, TransbankSale,
 * Cuadratura/Cruce Transbank, ni la configuración.
 *
 * OJO: si solo querés sacar los TBK colados sin perder lo conciliado, usá
 * scripts/clean-tbk-tesoreria.ts en su lugar.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/clean-tesoreria.ts            # dry-run: solo reporta
 *   npx tsx scripts/clean-tesoreria.ts --apply    # borra TODO el feed 200
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

async function main() {
  const total = await prisma.tesoreriaMovement.count();
  const consolidados = await prisma.consolidado.count();
  const links = await prisma.consolidadoLink.count({
    where: { consolidado: { is: { tesoreriaMovement: { is: {} } } } },
  });
  const conLink = await prisma.tesoreriaMovement.count({
    where: { consolidado: { is: { links: { some: {} } } } },
  });

  console.log("===== Limpieza TOTAL Movimientos 200 (TesoreriaMovement) =====");
  console.log(`  TesoreriaMovement a borrar:          ${total}`);
  console.log(`     ── con conciliación (link banco):  ${conLink}`);
  console.log(`  Consolidado en cascada:              ${consolidados}`);
  console.log(`  ConsolidadoLink en cascada:          ${links}`);

  if (total === 0) {
    console.log("\nNada que borrar.");
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[DRY-RUN] No se borró nada. Para borrar TODO el feed 200:` +
        `\n  npx tsx scripts/clean-tesoreria.ts --apply` +
        `\n\nDespués: "Sincronizar ahora" en Movimientos y re-ejecutar el motor.`
    );
    return;
  }

  const res = await prisma.tesoreriaMovement.deleteMany();
  console.log(`\n[APPLY] Borrados ${res.count} TesoreriaMovement (y sus Consolidado/Link en cascada).`);
  console.log(
    `        Ahora: "Sincronizar ahora" en Movimientos y re-ejecutá el motor (Consolidados).`
  );
}

main()
  .catch((e) => {
    console.error("Error en la limpieza:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
