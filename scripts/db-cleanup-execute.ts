/**
 * EJECUTA la limpieza de BD: borra datos transaccionales y derivados.
 * Preserva: User, BankAccount, BranchAccountHint.
 *
 * Orden de borrado respeta foreign keys (de hijos a padres).
 * Si algún paso falla, la transacción hace rollback y nada se pierde.
 */
import { prisma } from "../src/lib/db";

function fmt(n: number | bigint): string {
  return new Intl.NumberFormat("es-CL").format(Number(n));
}

async function main() {
  console.log("═".repeat(60));
  console.log("EJECUTANDO LIMPIEZA DE BD");
  console.log("═".repeat(60));

  const before = {
    reconciliationLinks: await prisma.reconciliationLink.count(),
    reconciliations: await prisma.reconciliation.count(),
    bankMovements: await prisma.bankMovement.count(),
    statementImports: await prisma.statementImport.count(),
    dynatechMovements: await prisma.dynatechMovement.count(),
    dynatechSyncRuns: await prisma.dynatechSyncRun.count(),
  };
  const preservadosAntes = {
    users: await prisma.user.count(),
    bankAccounts: await prisma.bankAccount.count(),
    branchHints: await prisma.branchAccountHint.count(),
  };

  console.log("\n📥 Antes del cleanup:");
  for (const [k, v] of Object.entries(before)) {
    console.log(`  ${k.padEnd(24)} ${fmt(v).padStart(6)}`);
  }

  // Ejecutar en transacción para que sea atómico
  console.log("\n🗑  Borrando…");
  const result = await prisma.$transaction(async (tx) => {
    const links = await tx.reconciliationLink.deleteMany();
    const recons = await tx.reconciliation.deleteMany();
    const banks = await tx.bankMovement.deleteMany();
    const imports = await tx.statementImport.deleteMany();
    const dyns = await tx.dynatechMovement.deleteMany();
    const syncs = await tx.dynatechSyncRun.deleteMany();
    return {
      reconciliationLinks: links.count,
      reconciliations: recons.count,
      bankMovements: banks.count,
      statementImports: imports.count,
      dynatechMovements: dyns.count,
      dynatechSyncRuns: syncs.count,
    };
  });

  for (const [k, v] of Object.entries(result)) {
    console.log(`  ${k.padEnd(24)} -${fmt(v)} borrados`);
  }

  // Verificación post
  console.log("\n📤 Después del cleanup:");
  const after = {
    reconciliationLinks: await prisma.reconciliationLink.count(),
    reconciliations: await prisma.reconciliation.count(),
    bankMovements: await prisma.bankMovement.count(),
    statementImports: await prisma.statementImport.count(),
    dynatechMovements: await prisma.dynatechMovement.count(),
    dynatechSyncRuns: await prisma.dynatechSyncRun.count(),
  };
  for (const [k, v] of Object.entries(after)) {
    const ok = v === 0 ? "✓" : "✗";
    console.log(`  ${ok} ${k.padEnd(24)} ${fmt(v).padStart(6)}`);
  }

  // Confirmar preservación
  console.log("\n🟢 Preservados intactos:");
  const preservadosDespues = {
    users: await prisma.user.count(),
    bankAccounts: await prisma.bankAccount.count(),
    branchHints: await prisma.branchAccountHint.count(),
  };
  for (const [k, v] of Object.entries(preservadosDespues)) {
    const antes = preservadosAntes[k as keyof typeof preservadosAntes];
    const ok = antes === v ? "✓" : "✗";
    console.log(`  ${ok} ${k.padEnd(24)} ${fmt(v).padStart(6)}  (antes: ${fmt(antes)})`);
  }

  // Mostrar las BankAccounts preservadas
  const accounts = await prisma.bankAccount.findMany({
    select: { bankCode: true, bankName: true, holderName: true, displayNumber: true, accountNumber: true },
    orderBy: [{ bankCode: "asc" }, { holderName: "asc" }],
  });
  console.log("\n📋 Cuentas bancarias preservadas:");
  for (const a of accounts) {
    console.log(`  · ${a.bankCode.padEnd(13)} ${a.holderName.padEnd(20)} ${a.displayNumber ?? a.accountNumber}`);
  }

  console.log("\n" + "═".repeat(60));
  console.log("✅ LISTO. La BD quedó limpia y lista para repoblar.");
  console.log("═".repeat(60));
  console.log(`
  Próximos pasos:
    1. npm run dev   (si no está corriendo)
    2. Login → Dynatech → "Sincronizar ahora"
    3. Cartolas → "Subir cartola" (cargá tus .xlsx)
    4. Conciliación → "Procesar matching"
  `);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("ERROR:", e);
  await prisma.$disconnect();
  process.exit(1);
});
