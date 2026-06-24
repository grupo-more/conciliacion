/**
 * BACKUP COMPLETO y RESTAURABLE de la BD. Pensado como red de seguridad antes
 * de correr scripts/reset-data.ts: si el borrado te deja mal, restaurás con
 * scripts/restore-db.ts y volvés exactamente al estado del backup.
 *
 * A diferencia de scripts/dump-db.ts (que cruza/transforma datos para análisis
 * y NO trae usuarios), esto vuelca las 27 tablas CRUDAS, fila por fila, con
 * todos los campos — incluidos User/passwordHash, config y JSON crudos — para
 * poder reinsertar sin pérdida.
 *
 * Serialización sin pérdida:
 *   - BigInt  → { "__bigint__": "123" }  (revivido por restore-db.ts)
 *   - Decimal → string (Prisma lo acepta de vuelta en create)
 *   - Date    → ISO string
 *   - Json    → tal cual (no contiene bigints)
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/backup-db.ts
 *
 * Salida:
 *   dumps/backup_<YYYY-MM-DDTHH-mm-ss>.json   (gitignored)
 *
 * Guardá ese archivo en un lugar seguro. Para restaurar:
 *   npx tsx scripts/restore-db.ts --file=dumps/backup_<...>.json          → dry-run
 *   npx tsx scripts/restore-db.ts --file=dumps/backup_<...>.json --apply  → restaura
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync, statSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });

/**
 * Orden de dump = orden de inserción al restaurar (padres antes que hijos para
 * respetar las FKs). restore-db.ts borra en el orden inverso. Mantené esta
 * lista sincronizada con la de restore-db.ts.
 */
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

async function main() {
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  // Sin Date.now(): timestamp legible en el nombre del archivo.
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const outPath = resolve(dumpsDir, `backup_${stamp}.json`);

  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const name of MODELS) {
    const rows = await (
      prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>
    )[name].findMany();
    tables[name] = rows;
    counts[name] = rows.length;
  }

  const dump = {
    backupVersion: 1,
    generatedAt: new Date().toISOString(),
    modelOrder: MODELS,
    counts,
    tables,
  };

  const json = JSON.stringify(
    dump,
    (_k, v) => (typeof v === "bigint" ? { __bigint__: v.toString() } : v),
    2,
  );
  writeFileSync(outPath, json, "utf8");

  const sizeMb = (statSync(outPath).size / 1_048_576).toFixed(2);

  console.log("=".repeat(60));
  console.log("BACKUP COMPLETO (restaurable)");
  console.log("=".repeat(60));
  console.table(counts);
  console.log(`\nArchivo : ${outPath}`);
  console.log(`Tamaño  : ${sizeMb} MB`);
  console.log("\nGuardalo en un lugar seguro. Para restaurar:");
  console.log(`  npx tsx scripts/restore-db.ts --file=${outPath}            → dry-run`);
  console.log(`  npx tsx scripts/restore-db.ts --file=${outPath} --apply    → restaura`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
