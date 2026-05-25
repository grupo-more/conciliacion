/**
 * Muestra el plan de limpieza de BD sin ejecutar nada.
 * Imprime los conteos actuales y qué tabla quedaría vacía o intacta.
 */
import { prisma } from "../src/lib/db";

function fmt(n: number | bigint): string {
  return new Intl.NumberFormat("es-CL").format(Number(n));
}

async function main() {
  const counts = {
    users: await prisma.user.count(),
    bankAccounts: await prisma.bankAccount.count(),
    branchHints: await prisma.branchAccountHint.count(),
    statementImports: await prisma.statementImport.count(),
    bankMovements: await prisma.bankMovement.count(),
    dynatechMovements: await prisma.dynatechMovement.count(),
    dynatechSyncRuns: await prisma.dynatechSyncRun.count(),
    reconciliations: await prisma.reconciliation.count(),
    reconciliationLinks: await prisma.reconciliationLink.count(),
  };

  console.log("═".repeat(60));
  console.log("PLAN DE LIMPIEZA DE BD (no se ejecuta nada todavía)");
  console.log("═".repeat(60));

  console.log("\n🟢 SE PRESERVAN (configuración del sistema):");
  console.log(`  User                  ${fmt(counts.users).padStart(6)}  ← cuentas de usuarios del panel`);
  console.log(`  BankAccount           ${fmt(counts.bankAccounts).padStart(6)}  ← cuentas bancarias registradas`);
  console.log(`  BranchAccountHint     ${fmt(counts.branchHints).padStart(6)}  ← hints sucursal → cuenta (configuración manual)`);

  console.log("\n🔴 SE BORRA (datos transaccionales y derivados):");
  console.log(`  ReconciliationLink    ${fmt(counts.reconciliationLinks).padStart(6)}  ← links bank ↔ dyn`);
  console.log(`  Reconciliation        ${fmt(counts.reconciliations).padStart(6)}  ← conciliaciones`);
  console.log(`  BankMovement          ${fmt(counts.bankMovements).padStart(6)}  ← movimientos de cartola`);
  console.log(`  StatementImport       ${fmt(counts.statementImports).padStart(6)}  ← registros de import de cartola`);
  console.log(`  DynatechMovement      ${fmt(counts.dynatechMovements).padStart(6)}  ← ventas Dynatech`);
  console.log(`  DynatechSyncRun       ${fmt(counts.dynatechSyncRuns).padStart(6)}  ← histórico de syncs`);

  console.log("\n" + "═".repeat(60));
  console.log("ORDEN DE BORRADO (respeta foreign keys):");
  console.log("═".repeat(60));
  console.log(`
  1. ReconciliationLink  (referencia a Reconciliation y BankMovement)
  2. Reconciliation      (referencia a DynatechMovement)
  3. BankMovement        (referencia a StatementImport y BankAccount)
  4. StatementImport     (referencia a BankAccount)
  5. DynatechMovement
  6. DynatechSyncRun
  `);

  console.log("═".repeat(60));
  console.log("DESPUÉS DEL CLEANUP, EL FLUJO ES:");
  console.log("═".repeat(60));
  console.log(`
  1. Abrir el panel → ir a "Dynatech" → "Sincronizar ahora"
     (trae todas las ventas desde la API)

  2. Ir a "Cartolas" → "Subir cartola"
     (cargás los .xlsx de los bancos uno por uno o en lote)

  3. Ir a "Conciliación" → "Procesar matching"
     (ejecuta el matching con el sistema de score nuevo)

  4. Revisar el dashboard y los estados (AUTO/SUGGESTED/REVIEW)
  `);

  console.log("═".repeat(60));
  console.log("¿Confirmás? Ejecutá:  npx tsx scripts/db-cleanup-execute.ts");
  console.log("═".repeat(60));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
