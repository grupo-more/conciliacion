/**
 * Borra un StatementImport (y por cascada sus BankMovements) para permitir
 * re-subir la misma cartola con la cuenta destino correcta.
 *
 * Caso de uso: subiste un archivo antes de tener el wizard de resolucion de
 * cuenta, los movimientos cayeron al placeholder "Sin asignar - X", y ahora
 * queres re-subirlos para crear la cuenta correcta. Ejecutar este script
 * deja el sistema como si nunca hubieras subido ese archivo.
 *
 * Uso:
 *   npx tsx scripts/reset-import.ts                            → lista los imports al placeholder
 *   npx tsx scripts/reset-import.ts --bank=MERCADOPAGO         → filtra por banco
 *   npx tsx scripts/reset-import.ts --import-id=<uuid> --apply → borra ese import
 *
 * El borrado es transaccional. Tambien limpia la cuenta placeholder si queda
 * sin movimientos (opcional con --drop-placeholder).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DROP_PLACEHOLDER = args.includes("--drop-placeholder");

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const v = args.find((a) => a.startsWith(prefix));
  return v ? v.slice(prefix.length) : undefined;
}

const bankFilter = arg("bank");
const importId = arg("import-id");

async function main() {
  const where: { account: { accountNumber: { startsWith: string }; bankCode?: string } } = {
    account: { accountNumber: { startsWith: "_UNASSIGNED_" } },
  };
  if (bankFilter) where.account.bankCode = bankFilter;

  const imports = await prisma.statementImport.findMany({
    where,
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          holderName: true,
        },
      },
      _count: { select: { movements: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  console.log("=".repeat(72));
  console.log(`Imports en placeholders "Sin asignar"${APPLY ? "  [MODO APPLY]" : "  [DRY-RUN]"}`);
  console.log("=".repeat(72));

  if (imports.length === 0) {
    console.log("No hay imports en placeholders. Nada que limpiar.");
    await prisma.$disconnect();
    return;
  }

  for (const imp of imports) {
    console.log(`\n  id        : ${imp.id}`);
    console.log(`  banco     : ${imp.account.bankName} (${imp.account.bankCode})`);
    console.log(`  cuenta    : ${imp.account.holderName} · ${imp.account.accountNumber}`);
    console.log(`  archivo   : ${imp.fileName}`);
    console.log(`  importado : ${imp.createdAt.toISOString()}`);
    console.log(`  movs      : ${imp._count.movements}`);
  }

  if (!importId) {
    console.log("");
    console.log("Para borrar uno especifico, corré:");
    console.log("  npx tsx scripts/reset-import.ts --import-id=<id> --apply");
    console.log("");
    console.log("Para tambien dropear la cuenta placeholder si queda vacia:");
    console.log("  npx tsx scripts/reset-import.ts --import-id=<id> --apply --drop-placeholder");
    await prisma.$disconnect();
    return;
  }

  const target = imports.find((i) => i.id === importId);
  if (!target) {
    console.log(`\n✗ Import ${importId} no esta en la lista (no es placeholder o no existe).`);
    await prisma.$disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\nVa a borrarse el import ${importId} y sus ${target._count.movements} movimientos.`);
    console.log("Para confirmar: agregá --apply.");
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Borrar movimientos del import (cascade desde statementImport).
    const deletedMovs = await tx.bankMovement.deleteMany({
      where: { statementImportId: target.id },
    });
    console.log(`✓ Borrados ${deletedMovs.count} movimientos.`);

    await tx.statementImport.delete({ where: { id: target.id } });
    console.log(`✓ Borrado StatementImport ${target.id}.`);

    if (DROP_PLACEHOLDER) {
      const remaining = await tx.bankMovement.count({
        where: { accountId: target.account.id },
      });
      if (remaining === 0) {
        await tx.bankAccount.delete({ where: { id: target.account.id } });
        console.log(`✓ Borrada cuenta placeholder "${target.account.holderName}".`);
      } else {
        console.log(
          `~ Cuenta placeholder NO borrada: tiene ${remaining} movimiento(s) de otros imports.`,
        );
      }
    }
  });

  console.log("\nListo. Ahora re-subí el archivo desde la UI — esta vez deberías ver");
  console.log("el wizard de resolución de cuenta. Elegí 'Crear cuenta nueva'.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
