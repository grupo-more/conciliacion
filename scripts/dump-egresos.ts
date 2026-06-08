/**
 * Dump para analizar la conciliación de EGRESOS: gastos de /api/egresos
 * (EgresoMovement) contra las salidas de cartola (BankMovement OUT).
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/dump-egresos.ts
 *
 * Salida: dumps/egresos_dump_<YYYY-MM-DD>.json   (gitignored)
 * Copialo a la carpeta dump/ de tu máquina local y avisame.
 */

import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const TAKE = 100_000;

async function main() {
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dumpsDir, `egresos_dump_${today}.json`);

  const [egresos, outs, entidades, accounts] = await Promise.all([
    prisma.egresoMovement.findMany({ take: TAKE, orderBy: { fecha: "desc" } }),
    prisma.bankMovement.findMany({
      where: { direction: "OUT" },
      take: TAKE,
      orderBy: { postDate: "desc" },
      include: { account: { select: { bankName: true, holderName: true, displayNumber: true, accountNumber: true } } },
    }),
    prisma.entidadInterna.findMany({ where: { active: true } }),
    prisma.bankAccount.findMany({ select: { id: true, bankName: true, holderName: true, accountNumber: true, displayNumber: true } }),
  ]);

  const range = (arr: Date[]) => {
    if (!arr.length) return null;
    const t = arr.map((d) => d.getTime());
    return { min: new Date(Math.min(...t)).toISOString().slice(0, 10), max: new Date(Math.max(...t)).toISOString().slice(0, 10) };
  };

  const dump = {
    generatedAt: new Date().toISOString(),
    counts: {
      egresoMovement: egresos.length,
      bankMovementOut: outs.length,
      entidadesInternas: entidades.length,
      accounts: accounts.length,
    },
    ranges: {
      egresoMovement: range(egresos.map((e) => e.fecha)),
      bankMovementOut: range(outs.map((b) => b.postDate)),
    },
    rubrosEgresos: [...new Set(egresos.map((e) => e.rubroNombre))],
    entidadesInternas: entidades.map((e) => ({
      rutCanonico: e.rutCanonico, nombreCanonico: e.nombreCanonico, aliases: e.aliases, rubro: e.rubro,
    })),
    accounts,
    egresos: egresos.map((e) => ({
      externalId: e.externalId, fecha: e.fecha, monto: e.monto, glosa: e.glosa,
      sucursalId: e.sucursalId, sucursalName: e.sucursalName,
      cajeroName: e.cajeroName, rubroId: e.rubroId, rubroNombre: e.rubroNombre,
    })),
    bankOut: outs.map((b) => ({
      postDate: b.postDate, amount: b.amount, accountId: b.accountId,
      bankName: b.account.bankName, holderName: b.account.holderName,
      accountNumber: b.account.displayNumber ?? b.account.accountNumber,
      counterpartyName: b.counterpartyName, counterpartyRut: b.counterpartyRut,
      description: b.description,
    })),
  };

  const json = JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(outPath, json, "utf8");

  console.log("=".repeat(60));
  console.log("DUMP EGRESOS (api/egresos vs cartola OUT)");
  console.log("=".repeat(60));
  console.log(JSON.stringify(dump.counts, null, 2));
  console.log("rangos:", JSON.stringify(dump.ranges));
  console.log(`\nArchivo: ${outPath}`);
  console.log("Copialo a dump/ en tu máquina local y avisame.");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
