/**
 * Export de egresos (BankMovement OUT) para análisis de detección de
 * "entidades internas" en cartolas.
 *
 * Contexto del análisis:
 *  - Cada entidad interna se va a registrar en Configuración como
 *    { RUT canónico, nombre canónico, [variantes de nombre observadas] }.
 *  - En la cartola, a veces viene counterpartyRut, a veces solo
 *    counterpartyName, a veces ambos, a veces ninguno.
 *  - Para los casos sin RUT, vamos a resolver la identidad por variante de
 *    nombre. Este export es la materia prima para descubrir qué variantes
 *    aparecen efectivamente en la data.
 *
 * Uso (en el servidor, con DATABASE_URL apuntando a la BD de prod):
 *   npx tsx scripts/export-egresos-out.ts
 *
 * Salida:
 *   dumps/egresos_out_<YYYY-MM-DD>.csv   (gitignored)
 *
 * Imprime además un resumen a stdout: totales, cuántos con rut, cuántos con
 * solo nombre, cuántos sin ninguno, distintos ruts, distintos nombres.
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
  const outPath = resolve(dumpsDir, `egresos_out_${today}.csv`);

  const ws = createWriteStream(outPath, { encoding: "utf8" });
  ws.write("﻿"); // BOM para que Excel abra UTF-8 correctamente
  ws.write(COLUMNS.join(",") + "\n");

  let cursor: string | undefined = undefined;
  let total = 0;
  let withRut = 0;
  let withName = 0;
  let withBoth = 0;
  let withNeither = 0;
  const distinctRuts = new Set<string>();
  const distinctNames = new Set<string>();

  while (true) {
    const batch: Awaited<ReturnType<typeof fetchBatch>> = await fetchBatch(cursor);
    if (batch.length === 0) break;

    for (const m of batch) {
      const row = [
        m.id,
        m.accountId,
        m.account.bankCode,
        m.account.alias ?? "",
        m.account.displayNumber ?? m.account.accountNumber,
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

      const hasRut = !!m.counterpartyRut && m.counterpartyRut.trim().length > 0;
      const hasName =
        !!m.counterpartyName && m.counterpartyName.trim().length > 0;
      if (hasRut && hasName) withBoth++;
      else if (hasRut) withRut++;
      else if (hasName) withName++;
      else withNeither++;
      if (hasRut) distinctRuts.add(m.counterpartyRut!.trim());
      if (hasName) distinctNames.add(m.counterpartyName!.trim().toLowerCase());
      total++;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < BATCH_SIZE) break;
    process.stdout.write(`  ... ${total} filas\r`);
  }

  await new Promise<void>((res, rej) => {
    ws.end((err?: Error | null) => (err ? rej(err) : res()));
  });

  const ruts = withRut + withBoth;
  const namesOnly = withName;
  const both = withBoth;
  const neither = withNeither;

  console.log("\n");
  console.log("=".repeat(60));
  console.log("EXPORT EGRESOS (BankMovement OUT)");
  console.log("=".repeat(60));
  console.log(`Total egresos exportados: ${total}`);
  console.log(`  con RUT (con o sin nombre): ${ruts}   (${pct(ruts, total)}%)`);
  console.log(`    └ con RUT y nombre:       ${both}    (${pct(both, total)}%)`);
  console.log(`    └ con RUT sin nombre:     ${withRut} (${pct(withRut, total)}%)`);
  console.log(`  solo nombre (sin RUT):      ${namesOnly} (${pct(namesOnly, total)}%)`);
  console.log(`  sin RUT ni nombre:          ${neither}  (${pct(neither, total)}%)`);
  console.log("");
  console.log(`RUTs distintos vistos:       ${distinctRuts.size}`);
  console.log(`Nombres distintos (case-insensitive): ${distinctNames.size}`);
  console.log("");
  console.log(`Archivo: ${outPath}`);
  console.log("");
  console.log(
    "Subí o copiá ese CSV a la máquina de Diego (dumps/ está gitignored)\n" +
      "y avisame para arrancar con el análisis de variantes de nombre.",
  );

  await prisma.$disconnect();
}

async function fetchBatch(cursor: string | undefined) {
  return prisma.bankMovement.findMany({
    where: { direction: "OUT" },
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
