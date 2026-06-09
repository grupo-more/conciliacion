/**
 * Diagnóstico read-only del estado de importación de cartolas.
 *
 * Muestra:
 *   - Cada BankAccount con su cantidad de movimientos (incluye "Sin asignar").
 *   - Los últimos imports (StatementImport): archivo, cuenta, filas
 *     total/insertadas/duplicadas/fallidas.
 *
 * Uso (en el servidor): npx tsx scripts/diag-import.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.bankAccount.findMany({
    include: { _count: { select: { movements: true } } },
    orderBy: [{ bankCode: "asc" }, { accountNumber: "asc" }],
  });

  console.log("\n=== Cuentas y cantidad de movimientos ===");
  console.table(
    accounts.map((a) => ({
      banco: a.bankCode,
      cuenta: a.displayNumber || a.accountNumber,
      titular: a.holderName,
      movimientos: a._count.movements,
      activa: a.active,
    })),
  );

  const imports = await prisma.statementImport.findMany({
    include: { account: { select: { bankCode: true, accountNumber: true, holderName: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  console.log("\n=== Últimos 20 imports ===");
  console.table(
    imports.map((i) => ({
      creado: i.createdAt.toISOString().slice(0, 19).replace("T", " "),
      archivo: i.fileName.slice(0, 50),
      cuenta: `${i.account.bankCode} ${i.account.accountNumber} (${i.account.holderName})`,
      total: i.rowsTotal,
      insertadas: i.rowsInserted,
      duplicadas: i.rowsDuplicated,
      fallidas: i.rowsFailed,
    })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
