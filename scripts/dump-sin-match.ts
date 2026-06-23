/**
 * Dump de movimientos de cartola (BankMovement) SIN match de ningún tipo, para
 * cruzarlos a mano contra el total de movimientos de las APIs (Dynatech /
 * Tesorería, etc.).
 *
 * "Sin match" = no tiene NINGUNO de:
 *   - consolidadoLinks        (conciliación principal IN ↔ TesoreriaMovement)
 *   - egresoConciliacionLinks (egresos a terceros ↔ EGRESO de Dynatech)
 *   - asientoManual           (asiento contable hecho a mano)
 *
 * Incluye IN y OUT. NO filtra Transbank / uso parcial / anulados: los marca con
 * columnas-bandera para que puedas filtrar en Excel sin perder visibilidad.
 *
 * Uso (con DATABASE_URL apuntando a la base que quieras analizar):
 *   npx tsx scripts/dump-sin-match.ts
 *   npx tsx scripts/dump-sin-match.ts --in     # solo abonos
 *   npx tsx scripts/dump-sin-match.ts --out    # solo cargos
 *
 * Salida:
 *   dumps/sin_match_<YYYY-MM-DD>.csv   (gitignored)
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import { isUsoParcialAccount } from "../src/lib/cuentas/uso-parcial";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const COLUMNS = [
  "id",
  "bankCode",
  "accountAlias",
  "accountNumber",
  "holderRut",
  "holderName",
  "postDate",
  "amount",
  "direction",
  "description",
  "counterpartyName",
  "counterpartyRut",
  "counterpartyAccount",
  "counterpartyBank",
  "branchLabel",
  "txType",
  "externalId",
  // Banderas para filtrar en Excel:
  "esTransbankAbono",
  "esUsoParcial",
] as const;

const BATCH_SIZE = 2000;

/** Mismo criterio que /api/bank-movements para detectar abonos Transbank. */
function esTransbankAbono(desc: string): boolean {
  const d = desc.toLowerCase();
  return d.includes("abn crd") && d.includes("transba");
}

async function main() {
  const onlyIn = process.argv.includes("--in");
  const onlyOut = process.argv.includes("--out");

  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const suffix = onlyIn ? "_in" : onlyOut ? "_out" : "";
  const outPath = resolve(dumpsDir, `sin_match_${today}${suffix}.csv`);

  const ws = createWriteStream(outPath, { encoding: "utf8" });
  ws.write("﻿"); // BOM para que Excel lea UTF-8
  ws.write(COLUMNS.join(",") + "\n");

  // "Sin match": ningún link de conciliación ni asiento manual.
  const where: Prisma.BankMovementWhereInput = {
    consolidadoLinks: { none: {} },
    egresoConciliacionLinks: { none: {} },
    asientoManual: { is: null },
  };
  if (onlyIn) where.direction = "IN";
  if (onlyOut) where.direction = "OUT";

  let cursor: string | undefined = undefined;
  let total = 0;
  let countIn = 0;
  let countOut = 0;
  let countTbk = 0;
  let countUsoParcial = 0;
  const accountsSeen = new Set<string>();

  while (true) {
    const batch = await fetchBatch(where, cursor);
    if (batch.length === 0) break;

    for (const m of batch) {
      const desc = m.description ?? "";
      const tbk = esTransbankAbono(desc);
      const usoParcial = isUsoParcialAccount({
        bankCode: m.account.bankCode,
        accountNumber: m.account.accountNumber,
        displayNumber: m.account.displayNumber,
      });

      const row = [
        m.id,
        m.account.bankCode,
        m.account.alias ?? "",
        m.account.displayNumber ?? m.account.accountNumber,
        m.account.holderRut ?? "",
        m.account.holderName ?? "",
        m.postDate.toISOString().slice(0, 10),
        m.amount.toString(),
        m.direction,
        desc,
        m.counterpartyName ?? "",
        m.counterpartyRut ?? "",
        m.counterpartyAccount ?? "",
        m.counterpartyBank ?? "",
        m.branchLabel ?? "",
        m.txType ?? "",
        m.externalId ?? "",
        tbk ? "1" : "0",
        usoParcial ? "1" : "0",
      ].map(csvEscape);
      ws.write(row.join(",") + "\n");

      if (m.direction === "IN") countIn++;
      else if (m.direction === "OUT") countOut++;
      if (tbk) countTbk++;
      if (usoParcial) countUsoParcial++;
      accountsSeen.add(m.accountId);
      total++;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
    process.stdout.write(`  ... ${total} filas\r`);
  }

  await new Promise<void>((res, rej) => {
    ws.end((err?: Error | null) => (err ? rej(err) : res()));
  });

  console.log("\n");
  console.log("=".repeat(60));
  console.log("DUMP MOVIMIENTOS SIN MATCH (BankMovement sin link ni asiento)");
  console.log("=".repeat(60));
  console.log(`Total sin match:          ${total}`);
  console.log(`  IN  (abonos):           ${countIn}   (${pct(countIn, total)}%)`);
  console.log(`  OUT (cargos):           ${countOut}  (${pct(countOut, total)}%)`);
  console.log("");
  console.log(`  de los cuales:`);
  console.log(`  - abonos Transbank:     ${countTbk}   (col esTransbankAbono=1)`);
  console.log(`  - cuentas uso parcial:  ${countUsoParcial}   (col esUsoParcial=1)`);
  console.log(`Cuentas bancarias vistas: ${accountsSeen.size}`);
  console.log("");
  console.log(`Archivo: ${outPath}`);

  await prisma.$disconnect();
}

async function fetchBatch(
  where: Prisma.BankMovementWhereInput,
  cursor: string | undefined,
) {
  return prisma.bankMovement.findMany({
    where,
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      account: {
        select: {
          bankCode: true,
          alias: true,
          accountNumber: true,
          displayNumber: true,
          holderRut: true,
          holderName: true,
        },
      },
    },
  });
}

function csvEscape(v: string): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0";
  return ((n / total) * 100).toFixed(1);
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
