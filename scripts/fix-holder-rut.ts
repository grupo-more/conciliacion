/**
 * Diagnostica BankAccounts cuyo holderRut esta vacio y propone (o aplica)
 * las correcciones cruzando holderName contra el nombre canonico + aliases
 * de las EntidadInterna registradas.
 *
 * Uso:
 *   npx tsx scripts/fix-holder-rut.ts          → DRY-RUN (solo imprime)
 *   npx tsx scripts/fix-holder-rut.ts --apply  → aplica los UPDATEs
 *
 * Idempotente: si una cuenta ya tiene holderRut cargado, no se toca.
 * Si la propuesta es ambigua (holderName matchea varias entidades), se
 * lista como "manual" sin aplicar — el operador decide.
 */
import { PrismaClient } from "@prisma/client";
import { normalizeRut } from "../src/lib/internos/detect";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface EntidadCandidate {
  rutCanonico: string;
  nombreCanonico: string;
  aliases: string[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[._-]/g, " ").replace(/\s+/g, " ").trim();
}

function matchEntity(
  holderName: string,
  entidades: EntidadCandidate[],
): EntidadCandidate[] {
  const n = norm(holderName);
  const hits: EntidadCandidate[] = [];
  for (const e of entidades) {
    const candidates = [e.nombreCanonico, ...e.aliases].map(norm);
    if (candidates.some((c) => n.includes(c) || c.includes(n))) {
      hits.push(e);
    }
  }
  // Dedupe por RUT canónico — el mismo entity puede haber matcheado por
  // nombre canónico Y por un alias.
  const seen = new Set<string>();
  return hits.filter((e) => {
    if (seen.has(e.rutCanonico)) return false;
    seen.add(e.rutCanonico);
    return true;
  });
}

async function main() {
  const entidades = await prisma.entidadInterna.findMany({
    where: { active: true },
    select: { rutCanonico: true, nombreCanonico: true, aliases: true },
  });

  if (entidades.length === 0) {
    console.log("No hay EntidadInterna cargada. Corré primero seed-entidades-internas.ts.");
    await prisma.$disconnect();
    return;
  }

  const accounts = await prisma.bankAccount.findMany({
    select: {
      id: true,
      bankCode: true,
      bankName: true,
      accountNumber: true,
      displayNumber: true,
      holderName: true,
      holderRut: true,
      active: true,
    },
    orderBy: [{ bankCode: "asc" }, { accountNumber: "asc" }],
  });

  console.log("=".repeat(72));
  console.log(`Diagnóstico de BankAccount.holderRut${APPLY ? "  [MODO APPLY]" : "  [DRY-RUN]"}`);
  console.log("=".repeat(72));
  console.log(`Cuentas totales: ${accounts.length}`);
  console.log(`Entidades internas activas: ${entidades.length}`);
  console.log("");

  const toUpdate: Array<{
    account: typeof accounts[number];
    target: EntidadCandidate;
  }> = [];
  const alreadyOk: typeof accounts = [];
  const ambiguous: Array<{
    account: typeof accounts[number];
    matches: EntidadCandidate[];
  }> = [];
  const noMatch: typeof accounts = [];

  for (const a of accounts) {
    if (a.holderRut && a.holderRut.trim().length > 0) {
      alreadyOk.push(a);
      continue;
    }
    const matches = matchEntity(a.holderName, entidades);
    if (matches.length === 0) noMatch.push(a);
    else if (matches.length === 1) toUpdate.push({ account: a, target: matches[0] });
    else ambiguous.push({ account: a, matches });
  }

  console.log(`✓ Ya tienen holderRut:          ${alreadyOk.length}`);
  console.log(`→ Propuestas de update (1:1):  ${toUpdate.length}`);
  console.log(`? Ambiguas (varias entidades): ${ambiguous.length}`);
  console.log(`× Sin match a entidad interna: ${noMatch.length}`);
  console.log("");

  if (toUpdate.length > 0) {
    console.log("PROPUESTAS DE UPDATE");
    console.log("-".repeat(72));
    for (const { account, target } of toUpdate) {
      console.log(
        `  ${account.bankName.padEnd(20)} ${account.holderName.padEnd(18)} ${account.displayNumber || account.accountNumber}`,
      );
      console.log(
        `    → holderRut = ${target.rutCanonico}   (${target.nombreCanonico})`,
      );
    }
    console.log("");
  }

  if (ambiguous.length > 0) {
    console.log("AMBIGUAS — revisar a mano");
    console.log("-".repeat(72));
    for (const { account, matches } of ambiguous) {
      console.log(
        `  ${account.bankName} ${account.holderName} ${account.displayNumber || account.accountNumber}`,
      );
      console.log(`    matchea: ${matches.map((m) => m.nombreCanonico).join(", ")}`);
    }
    console.log("");
  }

  if (noMatch.length > 0) {
    console.log("SIN MATCH a entidad interna (no se tocan)");
    console.log("-".repeat(72));
    for (const a of noMatch) {
      console.log(`  ${a.bankName} ${a.holderName} ${a.displayNumber || a.accountNumber}`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("=".repeat(72));
    console.log(
      "DRY-RUN. Para aplicar los updates 1:1, corré:\n" +
        "   npx tsx scripts/fix-holder-rut.ts --apply",
    );
    console.log("=".repeat(72));
    await prisma.$disconnect();
    return;
  }

  console.log("APLICANDO UPDATES...");
  for (const { account, target } of toUpdate) {
    const normalized = normalizeRut(target.rutCanonico);
    await prisma.bankAccount.update({
      where: { id: account.id },
      data: { holderRut: normalized },
    });
    console.log(
      `  ✓ ${account.bankName} ${account.holderName} → ${normalized}`,
    );
  }
  console.log(`\n${toUpdate.length} cuentas actualizadas.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
