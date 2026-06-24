/**
 * RESTAURA la BD desde un backup hecho con scripts/backup-db.ts. Úsalo si un
 * reset (scripts/reset-data.ts) te dejó mal: vuelve la base EXACTAMENTE al
 * estado del archivo de backup.
 *
 * Cómo funciona (todo dentro de UNA transacción, atómico):
 *   1) Borra TODAS las filas de las 27 tablas, en orden hijo→padre (FKs).
 *   2) Reinserta las filas del backup, en orden padre→hijo, con createMany.
 *   Si algo falla, la transacción hace rollback y la base queda como estaba.
 *
 * Reconstruye BigInt desde { "__bigint__": "..." }, y deja Decimal/Date como
 * string (Prisma los acepta en create).
 *
 * Uso:
 *   npx tsx scripts/restore-db.ts --file=dumps/backup_<...>.json           → DRY-RUN (no toca nada)
 *   npx tsx scripts/restore-db.ts --file=dumps/backup_<...>.json --apply   → restaura (DESTRUCTIVO)
 *
 * OJO: --apply REEMPLAZA todo el contenido actual por el del backup. Lo que
 * tengas ahora y no esté en el backup se pierde. Si dudás, hacé primero un
 * backup del estado actual con scripts/backup-db.ts.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const v = args.find((a) => a.startsWith(prefix));
  return v ? v.slice(prefix.length) : undefined;
}

// Orden padre→hijo para INSERTAR. El borrado va en reverso. Debe coincidir con
// MODELS de backup-db.ts.
const MODELS = [
  "user",
  "rubroLabel",
  "bankAccount",
  "bankAccountAlias",
  "statementImport",
  "bankMovement",
  "tesoreriaMovement",
  "tesoreriaSyncRun",
  "entidadInterna",
  "consolidado",
  "consolidadoLink",
  "difMenorSettings",
  "transbankImport",
  "transbankSale",
  "tbkTesoreria",
  "egresoMovement",
  "egresoConciliacion",
  "egresoConciliacionLink",
  "sucursal",
  "asientoManual",
  "asientoManualLinea",
  "asientoManualSettings",
  "cuadraturaTransbank",
  "cuadraturaTransbankItem",
  "cruceTransbankLink",
  "cuadraturaTransbankSettings",
  "cuadraturaTransbankApartado",
] as const;

/** Revive BigInt desde el formato { __bigint__: "123" } que escribe backup-db. */
function reviveBigInts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveBigInts);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.__bigint__ === "string" && Object.keys(obj).length === 1) {
      return BigInt(obj.__bigint__);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = reviveBigInts(v);
    return out;
  }
  return value;
}

async function main() {
  const file = arg("file");
  if (!file) {
    console.error("Falta --file=<ruta>. Ej: --file=dumps/backup_2026-06-24T10-00-00.json");
    process.exit(1);
  }
  const filePath = resolve(process.cwd(), file);
  if (!existsSync(filePath)) {
    console.error(`No existe el archivo: ${filePath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (raw.backupVersion !== 1 || !raw.tables) {
    console.error("El archivo no parece un backup válido de backup-db.ts (falta backupVersion/tables).");
    process.exit(1);
  }

  const tables = reviveBigInts(raw.tables) as Record<string, unknown[]>;

  console.log("=".repeat(60));
  console.log(`RESTORE desde ${file}`);
  console.log(`Backup generado: ${raw.generatedAt}`);
  console.log("=".repeat(60));
  console.table(raw.counts);

  if (!APPLY) {
    console.log(
      "\nDRY-RUN. No se tocó nada.\n" +
        "  Con --apply: se BORRAN todas las filas actuales (27 tablas) y se\n" +
        "  reinsertan las del backup, todo dentro de una transacción.\n" +
        "  Esto REEMPLAZA el estado actual por el del backup.\n",
    );
    await prisma.$disconnect();
    return;
  }

  console.log("\nAplicando restore (transacción atómica)…");

  await prisma.$transaction(
    async (tx) => {
      // 1) Borrar en orden hijo→padre.
      for (const name of [...MODELS].reverse()) {
        const res = await (
          tx as unknown as Record<string, { deleteMany: () => Promise<{ count: number }> }>
        )[name].deleteMany();
        if (res.count > 0) console.log(`  - borradas ${res.count} de ${name}`);
      }

      // 2) Insertar en orden padre→hijo.
      for (const name of MODELS) {
        const rows = tables[name] ?? [];
        if (rows.length === 0) continue;
        const res = await (
          tx as unknown as Record<
            string,
            { createMany: (a: { data: unknown[] }) => Promise<{ count: number }> }
          >
        )[name].createMany({ data: rows });
        console.log(`  + insertadas ${res.count} en ${name}`);
      }
    },
    { timeout: 120_000 },
  );

  console.log("\n✓ Restore completo. La base quedó en el estado del backup.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
