/**
 * Fix puntual del alias de banco "Santander BACO".
 *
 * PROBLEMA detectado en el análisis del dump 2026-06-25:
 *   El feed Dynatech manda banco="Santander BACO" (cuenta BACO SPA), pero el
 *   alias auto-detectado quedó como "Santander BAGO" (typo, con G). El motor de
 *   Consolidados resuelve la cuenta por match EXACTO de string
 *   (aliasMap.get(t.banco)), así que esos ~27 ingresos caen a OUT_OF_SCOPE con
 *   el motivo "Sin alias configurado para 'Santander BACO'", aunque el depósito
 *   SÍ está en la cartola de la cuenta BACO SPA.
 *
 * FIX: asegurar que exista un alias bancoString="Santander BACO" apuntando a la
 * misma cuenta que el alias "Santander BAGO" (o, si no existe, a la cuenta cuyo
 * holderName empieza con "BACO"). Idempotente: si ya está bien, no hace nada.
 *
 * Por defecto NO escribe (dry-run). Tras correrlo con --apply, ejecutar
 * "Re-evaluar todo" en Consolidados para que el motor reconcilie esos ingresos.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/fix-alias-baco.ts            # dry-run: muestra qué haría
 *   npx tsx scripts/fix-alias-baco.ts --apply    # aplica el fix
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const APPLY = process.argv.includes("--apply");

const TARGET = "Santander BACO"; // lo que manda Dynatech hoy
const TYPO = "Santander BAGO"; // alias viejo con typo

async function main() {
  const aliases = await prisma.bankAccountAlias.findMany({
    include: { account: { select: { id: true, bankName: true, holderName: true } } },
  });

  console.log("=== Alias actuales ===");
  for (const a of aliases) {
    console.log(`  "${a.bancoString}" -> ${a.account.bankName}/${a.account.holderName}`);
  }

  const yaExiste = aliases.find((a) => a.bancoString === TARGET);
  if (yaExiste) {
    console.log(`\n✓ Ya existe alias "${TARGET}" -> ${yaExiste.account.bankName}/${yaExiste.account.holderName}. Nada que hacer.`);
    return;
  }

  // Resolver la cuenta destino: la del alias con typo, o por holderName BACO.
  const typoAlias = aliases.find((a) => a.bancoString === TYPO);
  let accountId = typoAlias?.accountId ?? null;
  let via = typoAlias ? `alias "${TYPO}"` : "";
  if (!accountId) {
    const acc = await prisma.bankAccount.findFirst({
      where: { holderName: { startsWith: "BACO" }, bankName: { contains: "Santander", mode: "insensitive" } },
      select: { id: true, bankName: true, holderName: true },
    });
    accountId = acc?.id ?? null;
    via = acc ? `cuenta ${acc.bankName}/${acc.holderName}` : "";
  }

  if (!accountId) {
    console.error(`\n✗ No pude resolver la cuenta destino (ni alias "${TYPO}" ni cuenta holderName BACO). Abortado.`);
    process.exit(1);
  }

  console.log(`\nFIX: crear alias "${TARGET}" -> (resuelto vía ${via}).`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] No se escribió nada. Para aplicar:");
    console.log("  npx tsx scripts/fix-alias-baco.ts --apply");
    return;
  }

  await prisma.bankAccountAlias.create({
    data: {
      bancoString: TARGET,
      accountId,
      notes: "Fix manual: typo 'Santander BAGO' -> 'Santander BACO' (Dynatech manda BACO).",
    },
  });
  console.log(`\n[APPLY] Alias "${TARGET}" creado.`);
  console.log("Ahora corré \"Re-evaluar todo\" en Consolidados para reconciliar los ingresos.");
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
