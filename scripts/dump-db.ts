/**
 * Dump de diagnostico de la BD a un unico JSON, para analizar por que los
 * egresos no estan conciliando (y el estado general del matching).
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/dump-db.ts
 *
 * Salida:
 *   dumps/db_dump_<YYYY-MM-DD>.json   (gitignored)
 *
 * Despues: copia ese JSON a la carpeta dumps/ de tu maquina local y avisame
 * para leerlo. No trae datos sensibles de auth (no incluye usuarios/passwords).
 *
 * BigInt se serializa como string. Trae tablas completas (la base es chica);
 * si alguna crece mucho, ajustar TAKE.
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
  const outPath = resolve(dumpsDir, `db_dump_${today}.json`);

  const [
    bankAccounts,
    bankAccountAliases,
    entidadesInternas,
    rubroLabels,
    tesoreriaRaw,
    bankMovementsRaw,
    consolidadosRaw,
    syncRuns,
  ] = await Promise.all([
    prisma.bankAccount.findMany(),
    prisma.bankAccountAlias.findMany(),
    prisma.entidadInterna.findMany(),
    prisma.rubroLabel.findMany(),
    prisma.tesoreriaMovement.findMany({
      take: TAKE,
      orderBy: { fecha: "desc" },
      include: {
        consolidado: {
          select: {
            id: true,
            status: true,
            matchType: true,
            score: true,
            resolvedAccountId: true,
            _count: { select: { links: true } },
          },
        },
      },
    }),
    prisma.bankMovement.findMany({
      take: TAKE,
      orderBy: { postDate: "desc" },
      include: {
        account: {
          select: {
            bankCode: true,
            bankName: true,
            alias: true,
            accountNumber: true,
            displayNumber: true,
            holderName: true,
            holderRut: true,
          },
        },
        _count: { select: { consolidadoLinks: true } },
      },
    }),
    prisma.consolidado.findMany({
      take: TAKE,
      include: {
        links: { select: { bankMovementId: true, amountAllocated: true } },
      },
    }),
    prisma.tesoreriaSyncRun.findMany({
      take: 15,
      orderBy: { startedAt: "desc" },
    }),
  ]);

  // Resumen de egresos para imprimir en consola (diagnostico rapido).
  const egresos = tesoreriaRaw.filter(
    (t) => t.tipoOperacion === "EGRESO" || t.monto < 0n,
  );
  const egresosPorStatus: Record<string, number> = {};
  for (const e of egresos) {
    const st = e.consolidado?.status ?? "UNPROCESSED";
    egresosPorStatus[st] = (egresosPorStatus[st] ?? 0) + 1;
  }
  const outBmCount = bankMovementsRaw.filter((b) => b.direction === "OUT").length;

  const dump = {
    generatedAt: new Date().toISOString(),
    counts: {
      bankAccounts: bankAccounts.length,
      bankAccountAliases: bankAccountAliases.length,
      entidadesInternas: entidadesInternas.length,
      rubroLabels: rubroLabels.length,
      tesoreriaMovements: tesoreriaRaw.length,
      tesoreriaEgresos: egresos.length,
      bankMovements: bankMovementsRaw.length,
      bankMovementsOUT: outBmCount,
      consolidados: consolidadosRaw.length,
    },
    egresosPorStatus,
    bankAccounts,
    bankAccountAliases,
    entidadesInternas,
    rubroLabels,
    syncRuns,
    tesoreriaMovements: tesoreriaRaw.map((t) => ({
      id: t.id,
      externalId: t.externalId,
      fecha: t.fecha,
      monto: t.monto,
      tipoOperacion: t.tipoOperacion,
      banco: t.banco,
      bancoSucursal: t.bancoSucursal,
      bancoDetectado: t.bancoDetectado,
      rubroBanco: t.rubroBanco,
      rubroSucursal: t.rubroSucursal,
      esExcepcion: t.esExcepcion,
      sucursalName: t.sucursalName,
      clienteName: t.clienteName,
      clienteRut: t.clienteRut,
      glosa: t.glosa,
      consolidado: t.consolidado
        ? {
            status: t.consolidado.status,
            matchType: t.consolidado.matchType,
            score: t.consolidado.score,
            resolvedAccountId: t.consolidado.resolvedAccountId,
            linkCount: t.consolidado._count.links,
          }
        : null,
    })),
    bankMovements: bankMovementsRaw.map((b) => ({
      id: b.id,
      postDate: b.postDate,
      amount: b.amount,
      direction: b.direction,
      accountId: b.accountId,
      bankCode: b.account.bankCode,
      bankName: b.account.bankName,
      accountAlias: b.account.alias,
      accountNumber: b.account.displayNumber ?? b.account.accountNumber,
      holderName: b.account.holderName,
      holderRut: b.account.holderRut,
      description: b.description,
      counterpartyName: b.counterpartyName,
      counterpartyRut: b.counterpartyRut,
      linkCount: b._count.consolidadoLinks,
    })),
    consolidados: consolidadosRaw.map((c) => ({
      id: c.id,
      tesoreriaMovementId: c.tesoreriaMovementId,
      status: c.status,
      matchType: c.matchType,
      score: c.score,
      resolvedAccountId: c.resolvedAccountId,
      links: c.links,
    })),
  };

  const json = JSON.stringify(
    dump,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  writeFileSync(outPath, json, "utf8");

  console.log("=".repeat(60));
  console.log("DUMP DE DIAGNOSTICO");
  console.log("=".repeat(60));
  console.log(JSON.stringify(dump.counts, null, 2));
  console.log("\nEgresos por estado de conciliacion:");
  console.log(JSON.stringify(egresosPorStatus, null, 2));
  console.log(`\nArchivo: ${outPath}`);
  console.log(
    "\nCopia ese JSON a la carpeta dumps/ de tu maquina local y avisame.",
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
