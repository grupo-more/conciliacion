/**
 * Seed inicial de EntidadInterna con los 6 RUTs conocidos + las variantes de
 * nombre detectadas por scripts/analyze-internos.mjs sobre el dump del server.
 *
 * Uso (en el server, post-migracion):
 *   npx tsx scripts/seed-entidades-internas.ts
 *
 * Idempotente: usa upsert sobre rutCanonico. Si una entidad ya existe, fusiona
 * los aliases nuevos con los existentes sin duplicar (case-insensitive).
 *
 * Las variantes "Internet a <RUT>" NO se cargan como alias porque el detector
 * ya las cubre via cascada `rut_in_name` (parsea el RUT incrustado en el
 * counterpartyName). Cargar el RUT-en-nombre como alias seria redundante.
 */
import { PrismaClient } from "@prisma/client";
import { normalizeRut } from "../src/lib/internos/detect";

const prisma = new PrismaClient();

interface SeedEntidad {
  rut: string;
  nombreCanonico: string;
  rubro: number | null;
  aliases: string[];
  notas?: string;
}

const SEED: SeedEntidad[] = [
  {
    rut: "77.333.097-2",
    nombreCanonico: "MG",
    rubro: 198,
    aliases: ["MG SPA"],
    notas: "Detectado: 4 egresos con RUT directo + 3 huerfanos por nombre.",
  },
  {
    rut: "77.333.096-4",
    nombreCanonico: "ME",
    rubro: 197,
    aliases: ["ME SPA", "Me Spa"],
    notas: "Detectado: 31 egresos con RUT directo + 24 huerfanos por nombre.",
  },
  {
    rut: "77.333.099-9",
    nombreCanonico: "More Giros",
    rubro: null,
    aliases: ["More Giros", "M.Giros", "MoreGiros"],
    notas: "Sin egresos en el dump 2026-06-04 — aliases inferidos.",
  },
  {
    rut: "76.815.928-9",
    nombreCanonico: "More Capital",
    rubro: null,
    aliases: ["More Capital Spa", "MORE CAPITAL S", "MoreCapital"],
    notas: "Detectado: 109 egresos con RUT + 25 huerfanos por nombre (MORE CAPITAL S truncado).",
  },
  {
    rut: "76.611.709-0",
    nombreCanonico: "More Exchange",
    rubro: null,
    aliases: ["More Exchange", "MoreExchange"],
    notas: "Detectado: 7 egresos con RUT + 5 huerfanos por nombre.",
  },
  {
    rut: "78.026.624-4",
    nombreCanonico: "Baco SPA",
    rubro: null,
    aliases: ["Baco SPA", "Baco"],
    notas: "Sin egresos en el dump 2026-06-04 — aliases inferidos.",
  },
];

async function main() {
  console.log("Seed EntidadInterna — iniciando…\n");

  for (const e of SEED) {
    const rutCanonico = normalizeRut(e.rut);
    const existing = await prisma.entidadInterna.findUnique({
      where: { rutCanonico },
    });

    if (!existing) {
      const created = await prisma.entidadInterna.create({
        data: {
          rutCanonico,
          nombreCanonico: e.nombreCanonico,
          aliases: dedupe(e.aliases),
          rubro: e.rubro,
          notas: e.notas ?? null,
          active: true,
        },
      });
      console.log(`  + CREADO  ${created.nombreCanonico} (${e.rut})`);
      continue;
    }

    // Existente: fusionar aliases sin duplicar.
    const merged = dedupe([...existing.aliases, ...e.aliases]);
    const changed =
      merged.length !== existing.aliases.length ||
      existing.nombreCanonico !== e.nombreCanonico ||
      existing.rubro !== e.rubro;

    if (changed) {
      await prisma.entidadInterna.update({
        where: { rutCanonico },
        data: {
          nombreCanonico: e.nombreCanonico,
          aliases: merged,
          rubro: e.rubro ?? existing.rubro,
        },
      });
      console.log(
        `  ~ UPDATE  ${e.nombreCanonico} (${e.rut})  aliases: ${existing.aliases.length} -> ${merged.length}`,
      );
    } else {
      console.log(`  = SKIP    ${e.nombreCanonico} (${e.rut})  (sin cambios)`);
    }
  }

  const total = await prisma.entidadInterna.count();
  console.log(`\nTotal EntidadInterna en BD: ${total}`);
  console.log("Seed completo.\n");
  console.log(
    "Probá la deteccion en /dashboard/consolidados → tab 'Egresos internos'.",
  );

  await prisma.$disconnect();
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const t = a.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
