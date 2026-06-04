/**
 * Export completo de BankMovement (IN + OUT) para analizar el matching
 * espejo del modulo "Traspasos internos".
 *
 * Versión generalizada de export-egresos-out.ts: sin filtro por direction
 * y con dos columnas extra del BankAccount destino (holderRut, holderName)
 * porque las vamos a necesitar para identificar que cuenta nuestra recibio
 * cada movimiento.
 *
 * Uso (en el server, con DATABASE_URL apuntando a prod):
 *   npx tsx scripts/export-movimientos-all.ts
 *
 * Salida:
 *   dumps/movimientos_all_<YYYY-MM-DD>.csv   (gitignored)
 *
 * Imprime un resumen: total, breakdown IN/OUT, cuentas distintas vistas.
 */

import { PrismaClient } from "@prisma/client";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const COLUMNS = [
  "id",
  "accountId",
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
] as const;

const BATCH_SIZE = 2000;

async function main() {
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dumpsDir, `movimientos_all_${today}.csv`);

  const ws = createWriteStream(outPath, { encoding: "utf8" });
  ws.write("﻿"); // BOM para que Excel lea UTF-8
  ws.write(COLUMNS.join(",") + "\n");

  let cursor: string | undefined = undefined;
  let total = 0;
  let countIn = 0;
  let countOut = 0;
  const accountsSeen = new Set<string>();

  while (true) {
    const batch = await fetchBatch(cursor);
    if (batch.length === 0) break;

    for (const m of batch) {
      const row = [
        m.id,
        m.accountId,
        m.account.bankCode,
        m.account.alias ?? "",
        m.account.displayNumber ?? m.account.accountNumber,
        m.account.holderRut ?? "",
        m.account.holderName ?? "",
        m.postDate.toISOString().slice(0, 10),
        m.amount.toString(),
        m.direction,
        m.description ?? "",
        m.counterpartyName ?? "",
        m.counterpartyRut ?? "",
        m.counterpartyAccount ?? "",
        m.counterpartyBank ?? "",
        m.branchLabel ?? "",
        m.txType ?? "",
      ].map(csvEscape);
      ws.write(row.join(",") + "\n");

      if (m.direction === "IN") countIn++;
      else if (m.direction === "OUT") countOut++;
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
  console.log("EXPORT MOVIMIENTOS COMPLETOS (BankMovement IN + OUT)");
  console.log("=".repeat(60));
  console.log(`Total movimientos:        ${total}`);
  console.log(`  IN  (ingresos):         ${countIn}   (${pct(countIn, total)}%)`);
  console.log(`  OUT (egresos):          ${countOut}  (${pct(countOut, total)}%)`);
  console.log(`Cuentas bancarias vistas: ${accountsSeen.size}`);
  console.log("");
  console.log(`Archivo: ${outPath}`);
  console.log("");
  console.log(
    "Copiá ese CSV a c:\\Users\\mg001\\Desktop\\conciliacion\\dumps\\ y avisame\n" +
      "para arrancar con el matching OUT ↔ IN espejo.",
  );

  await prisma.$disconnect();
}

async function fetchBatch(cursor: string | undefined) {
  return prisma.bankMovement.findMany({
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
