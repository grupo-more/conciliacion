/**
 * Limpieza de movimientos TBK en TesoreriaMovement (Movimientos 200).
 *
 * Contexto: la API /dynatech empezó a mandar las ventas con tarjeta con
 * `tipoOperacion="TBK"` (clase guardada en `claseOperacion`). Al dejar de
 * descartarlas, entraron a Movimientos 200 y se solaparon con cosas que ya
 * estaban cuadradas. Este script borra ESOS movimientos TBK, pero SOLO los que
 * NO tienen un `Consolidado` colgando (es decir, los que NO están conciliados).
 *
 * Por qué es seguro:
 *   - `Consolidado` borra en cascada con su `TesoreriaMovement`. Por eso el
 *     guard `NOT EXISTS Consolidado`: nunca toca lo ya cuadrado.
 *   - La Cuadratura Transbank (el asiento) se arma con `TbkTesoreria`, una tabla
 *     aparte. Borrar acá no la afecta en absoluto.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/clean-tbk-tesoreria.ts            # dry-run: solo cuenta, no borra
 *   npx tsx scripts/clean-tbk-tesoreria.ts --apply    # borra los TBK sin conciliar
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

async function main() {
  // Total de TBK y cuántos están cuadrados (tienen Consolidado).
  const total = await prisma.tesoreriaMovement.count({
    where: { claseOperacion: "TBK" },
  });
  const cuadrados = await prisma.tesoreriaMovement.count({
    where: { claseOperacion: "TBK", consolidado: { isNot: null } },
  });
  const sinCuadrar = total - cuadrados;

  console.log("===== Limpieza TBK en Movimientos 200 (TesoreriaMovement) =====");
  console.log(`  TBK totales:        ${total}`);
  console.log(`  TBK cuadrados:      ${cuadrados}  (se PRESERVAN)`);
  console.log(`  TBK sin cuadrar:    ${sinCuadrar}  (candidatos a borrar)`);

  if (sinCuadrar === 0) {
    console.log("\nNo hay TBK sin cuadrar. Nada que borrar.");
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[DRY-RUN] No se borró nada. Para borrar los ${sinCuadrar} movimiento(s):` +
        `\n  npx tsx scripts/clean-tbk-tesoreria.ts --apply`
    );
    return;
  }

  const res = await prisma.tesoreriaMovement.deleteMany({
    where: { claseOperacion: "TBK", consolidado: { is: null } },
  });
  console.log(`\n[APPLY] Borrados ${res.count} movimiento(s) TBK sin cuadrar.`);
  console.log(`        Quedaron intactos ${cuadrados} TBK ya conciliados.`);
}

main()
  .catch((e) => {
    console.error("Error en la limpieza:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
