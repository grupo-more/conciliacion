/**
 * Limpia el sistema para empezar de cero (fase de pruebas).
 *
 * Por DEFECTO borra solo la DATA TRANSACCIONAL / importada y CONSERVA la
 * configuración (cuentas, alias, rubros, entidades internas, dif-settings y
 * usuarios). Es lo que normalmente querés para "reimportar todo de nuevo".
 *
 * Borra (data):
 *   ConsolidadoLink, Consolidado, EgresoConciliacionLink, EgresoConciliacion,
 *   AsientoManualLinea, AsientoManual, CuadraturaTransbankItem,
 *   CuadraturaTransbank, CuadraturaTransbankApartado, CruceTransbankLink,
 *   BankMovement, StatementImport, TransbankSale, TransbankImport,
 *   TesoreriaMovement, TesoreriaSyncRun, TbkTesoreria, EgresoMovement
 *
 * Conserva (config):
 *   User, BankAccount, BankAccountAlias, RubroLabel, EntidadInterna,
 *   DifMenorSettings, Sucursal, AsientoManualSettings,
 *   CuadraturaTransbankSettings
 *
 * Flags:
 *   (sin flags)        → DRY-RUN: solo muestra cuántas filas borraría.
 *   --apply            → ejecuta el borrado de data (transaccional).
 *   --wipe-config      → además borra la config (alias, rubros, entidades,
 *                        dif-settings, cuentas). Tras esto hay que correr el
 *                        seed (npm run db:seed) y reconfigurar alias/rubros/
 *                        entidades por la UI.
 *   --wipe-users       → además borra los usuarios (requiere --wipe-config).
 *                        Tras esto el login deja de funcionar hasta re-seedear.
 *
 * Uso (en el SERVIDOR, donde apunta DATABASE_URL):
 *   npx tsx scripts/reset-data.ts                      → previsualizar
 *   npx tsx scripts/reset-data.ts --apply              → limpiar data (recomendado)
 *   npx tsx scripts/reset-data.ts --apply --wipe-config
 *   npx tsx scripts/reset-data.ts --apply --wipe-config --wipe-users
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const WIPE_CONFIG = process.argv.includes("--wipe-config");
const WIPE_USERS = process.argv.includes("--wipe-users");

async function counts() {
  const [
    consolidadoLink,
    consolidado,
    egresoConciliacionLink,
    egresoConciliacion,
    asientoManualLinea,
    asientoManual,
    cuadraturaTransbankItem,
    cuadraturaTransbank,
    cuadraturaTransbankApartado,
    cruceTransbankLink,
    bankMovement,
    statementImport,
    transbankSale,
    transbankImport,
    tesoreriaMovement,
    tesoreriaSyncRun,
    tbkTesoreria,
    egresoMovement,
    bankAccountAlias,
    entidadInterna,
    rubroLabel,
    difMenorSettings,
    bankAccount,
    user,
  ] = await Promise.all([
    prisma.consolidadoLink.count(),
    prisma.consolidado.count(),
    prisma.egresoConciliacionLink.count(),
    prisma.egresoConciliacion.count(),
    prisma.asientoManualLinea.count(),
    prisma.asientoManual.count(),
    prisma.cuadraturaTransbankItem.count(),
    prisma.cuadraturaTransbank.count(),
    prisma.cuadraturaTransbankApartado.count(),
    prisma.cruceTransbankLink.count(),
    prisma.bankMovement.count(),
    prisma.statementImport.count(),
    prisma.transbankSale.count(),
    prisma.transbankImport.count(),
    prisma.tesoreriaMovement.count(),
    prisma.tesoreriaSyncRun.count(),
    prisma.tbkTesoreria.count(),
    prisma.egresoMovement.count(),
    prisma.bankAccountAlias.count(),
    prisma.entidadInterna.count(),
    prisma.rubroLabel.count(),
    prisma.difMenorSettings.count(),
    prisma.bankAccount.count(),
    prisma.user.count(),
  ]);
  return {
    consolidadoLink,
    consolidado,
    egresoConciliacionLink,
    egresoConciliacion,
    asientoManualLinea,
    asientoManual,
    cuadraturaTransbankItem,
    cuadraturaTransbank,
    cuadraturaTransbankApartado,
    cruceTransbankLink,
    bankMovement,
    statementImport,
    transbankSale,
    transbankImport,
    tesoreriaMovement,
    tesoreriaSyncRun,
    tbkTesoreria,
    egresoMovement,
    bankAccountAlias,
    entidadInterna,
    rubroLabel,
    difMenorSettings,
    bankAccount,
    user,
  };
}

async function main() {
  if (WIPE_USERS && !WIPE_CONFIG) {
    console.error("--wipe-users requiere --wipe-config. Abortado.");
    process.exit(1);
  }

  const before = await counts();
  console.log("\n=== Estado actual ===");
  console.table(before);

  if (!APPLY) {
    console.log(
      "\nDRY-RUN. No se borró nada. Agregá --apply para ejecutar.\n" +
        "  Data transaccional que se borraría: ConsolidadoLink, Consolidado,\n" +
        "  EgresoConciliacionLink, EgresoConciliacion, AsientoManualLinea,\n" +
        "  AsientoManual, CuadraturaTransbankItem, CuadraturaTransbank,\n" +
        "  CuadraturaTransbankApartado, CruceTransbankLink, BankMovement,\n" +
        "  StatementImport, TransbankSale, TransbankImport, TesoreriaMovement,\n" +
        "  TesoreriaSyncRun, TbkTesoreria, EgresoMovement.\n" +
        (WIPE_CONFIG
          ? "  + CONFIG (alias, entidades, rubros, dif-settings, cuentas)" +
            (WIPE_USERS ? " + USUARIOS" : "") +
            "\n"
          : "  Config conservada (cuentas, alias, rubros, entidades, usuarios).\n"),
    );
    return;
  }

  // 1) Data transaccional (orden hijo→padre para respetar FKs).
  console.log("\nBorrando data transaccional…");
  await prisma.$transaction([
    // hijos que apuntan a BankMovement / Consolidado / Egreso / Asiento / Cuadratura
    prisma.consolidadoLink.deleteMany(),
    prisma.consolidado.deleteMany(),
    prisma.egresoConciliacionLink.deleteMany(),
    prisma.egresoConciliacion.deleteMany(),
    prisma.asientoManualLinea.deleteMany(),
    prisma.asientoManual.deleteMany(),
    // tablas de cuadratura/cruce Transbank: SIN FK a TBK/settlement, no se
    // borran en cascada al limpiar las ventas → hay que borrarlas a mano.
    prisma.cuadraturaTransbankItem.deleteMany(),
    prisma.cuadraturaTransbank.deleteMany(),
    prisma.cuadraturaTransbankApartado.deleteMany(),
    prisma.cruceTransbankLink.deleteMany(),
    // padres
    prisma.bankMovement.deleteMany(),
    prisma.statementImport.deleteMany(),
    prisma.transbankSale.deleteMany(),
    prisma.transbankImport.deleteMany(),
    prisma.tesoreriaMovement.deleteMany(),
    prisma.tesoreriaSyncRun.deleteMany(),
    prisma.tbkTesoreria.deleteMany(),
    prisma.egresoMovement.deleteMany(),
  ]);
  console.log("✓ Data transaccional borrada.");

  // 2) Config (opcional).
  if (WIPE_CONFIG) {
    console.log("Borrando configuración…");
    await prisma.$transaction([
      prisma.bankAccountAlias.deleteMany(),
      prisma.entidadInterna.deleteMany(),
      prisma.difMenorSettings.deleteMany(),
      prisma.rubroLabel.deleteMany(),
      prisma.bankAccount.deleteMany(),
    ]);
    console.log("✓ Config borrada.");
    if (WIPE_USERS) {
      await prisma.user.deleteMany();
      console.log("✓ Usuarios borrados.");
    }
  }

  const after = await counts();
  console.log("\n=== Estado final ===");
  console.table(after);
  console.log(
    "\nListo. " +
      (WIPE_CONFIG
        ? "Corré el seed: npm run db:seed (recrea usuario + cuentas), y reconfigurá alias/rubros/entidades.\n"
        : "Config intacta. Reimportá cartolas y resincronizá Dynatech cuando quieras.\n"),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
