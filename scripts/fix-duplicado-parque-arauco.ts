/**
 * Limpieza puntual: bug de carga en MovCajaDepositos (Id 56310-56556, MCjId
 * 1000160316) que generó 247 copias de la misma transacción real (Parque
 * Arauco, Santander BACO, $46.000.000, 06-08-2026 10:50:59) en TesoreriaMovement.
 * La fuente (MovCajaDB) ya fue limpiada dejando solo Id=56310 ("CLIENTE
 * GENERICO", el valor correcto según el formulario de origen — el movimiento
 * es "Entrada de Caja" interno, sin cliente asociado). Este script borra las
 * 246 copias huérfanas equivalentes en TesoreriaMovement (external_id = Id de
 * MovCajaDepositos, sin offset — el offset de 1e9 solo aplica a filas que
 * vienen de MovCajaEgresos).
 *
 * Uso (EN EL SERVER, con DATABASE_URL real apuntando a la BD de conciliacion):
 *   npx tsx scripts/fix-duplicado-parque-arauco.ts            # dry-run: solo reporta
 *   npx tsx scripts/fix-duplicado-parque-arauco.ts --apply    # borra las 246 copias
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

const WHERE = {
  externalId: { gte: 56311n, lte: 56556n },
  sucursalId: 10,
  monto: -46000000n,
};

async function main() {
  const rows = await prisma.tesoreriaMovement.findMany({
    where: WHERE,
    select: { id: true, externalId: true, clienteName: true, fecha: true },
    orderBy: { externalId: "asc" },
  });

  console.log("===== Limpieza duplicado Parque Arauco (MCjId 1000160316) =====");
  console.log(`Filas encontradas: ${rows.length} (esperado: 246)`);

  if (rows.length > 0) {
    const porCliente = new Map<string, number>();
    for (const r of rows) {
      const k = r.clienteName ?? "(sin nombre)";
      porCliente.set(k, (porCliente.get(k) ?? 0) + 1);
    }
    console.log("Desglose por cliente:");
    for (const [k, n] of porCliente) console.log(`  ${k}: ${n}`);
  }

  if (rows.length === 0) {
    console.log("\nNada que borrar.");
    return;
  }

  if (!APPLY) {
    console.log(
      `\n[DRY-RUN] No se borró nada. Para aplicar:` +
        `\n  npx tsx scripts/fix-duplicado-parque-arauco.ts --apply`
    );
    return;
  }

  const res = await prisma.tesoreriaMovement.deleteMany({ where: WHERE });
  console.log(`\n[APPLY] Borrados ${res.count} TesoreriaMovement.`);
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
