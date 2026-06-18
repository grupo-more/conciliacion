/**
 * Limpieza one-off de movimientos TBK que se colaron en TesoreriaMovement
 * (Movimientos 200).
 *
 * Contexto: la API /dynatech empezó a mandar las ventas con tarjeta
 * (`tipoOperacion="TBK"`, guardado en `claseOperacion`). Esas ventas YA se
 * cuadran en el asiento de "Cruce Transbank" (tabla TbkTesoreria, aparte), así
 * que la copia que entró por Dynatech sobra y ensucia el motor de banco
 * (quedan como "Sin match"/NO_MATCH). La API se va a corregir aguas arriba para
 * no mandarlas más; este script limpia las que ya entraron, UNA vez.
 *
 * CRITERIO SEGURO — qué se borra y qué NO:
 *   - Se PRESERVA todo TBK que tenga al menos un `ConsolidadoLink` (vínculo real
 *     a un movimiento de banco). Por la lógica del sistema, solo AUTO_MATCHED y
 *     MANUAL generan links; esas son las conciliaciones de verdad.
 *   - Se BORRA todo TBK SIN link: sin `Consolidado`, o con `Consolidado` en
 *     NO_MATCH / SUGGESTED / REVIEW (propuestas o ruido, sin vínculo).
 *   Borrar arrastra en cascada su `Consolidado` y links — por eso el guard del
 *   link protege lo conciliado. NO toca la Cuadratura Transbank (tabla aparte).
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/clean-tbk-tesoreria.ts            # dry-run: solo reporta
 *   npx tsx scripts/clean-tbk-tesoreria.ts --apply    # borra los TBK sin link
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

// Un TBK es "borrable" si NO tiene ningún ConsolidadoLink: o no tiene
// Consolidado, o lo tiene pero sin links (NO_MATCH / SUGGESTED / REVIEW).
const DELETABLE_WHERE = {
  claseOperacion: "TBK" as const,
  OR: [
    { consolidado: { is: null } },
    { consolidado: { is: { links: { none: {} } } } },
  ],
};

async function main() {
  const total = await prisma.tesoreriaMovement.count({
    where: { claseOperacion: "TBK" },
  });
  const preservar = await prisma.tesoreriaMovement.count({
    where: { claseOperacion: "TBK", consolidado: { is: { links: { some: {} } } } },
  });
  const sinConsolidado = await prisma.tesoreriaMovement.count({
    where: { claseOperacion: "TBK", consolidado: { is: null } },
  });
  const borrables = await prisma.tesoreriaMovement.count({ where: DELETABLE_WHERE });

  // Desglose por estado de los borrables que SÍ tienen Consolidado (sin link).
  const byStatus = await prisma.consolidado.groupBy({
    by: ["status"],
    where: { tesoreriaMovement: { claseOperacion: "TBK" }, links: { none: {} } },
    _count: { _all: true },
  });

  console.log("===== Limpieza TBK colados en Movimientos 200 =====");
  console.log(`  TBK totales:                         ${total}`);
  console.log(`  PRESERVAR (con link real a banco):   ${preservar}`);
  console.log(`  BORRAR (sin link):                   ${borrables}`);
  console.log(`     ── sin Consolidado:               ${sinConsolidado}`);
  for (const s of byStatus) {
    console.log(`     ── ${s.status.padEnd(28)} ${s._count._all}`);
  }

  if (borrables === 0) {
    console.log("\nNada que borrar.");
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[DRY-RUN] No se borró nada. Para borrar los ${borrables} TBK sin link:` +
        `\n  npx tsx scripts/clean-tbk-tesoreria.ts --apply`
    );
    return;
  }

  const res = await prisma.tesoreriaMovement.deleteMany({ where: DELETABLE_WHERE });
  console.log(`\n[APPLY] Borrados ${res.count} TBK sin link.`);
  console.log(`        Preservados ${preservar} TBK con conciliación real.`);
}

main()
  .catch((e) => {
    console.error("Error en la limpieza:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
