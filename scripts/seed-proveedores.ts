/**
 * Seed del maestro ProveedorAsiento (Configuración → Proveedores): las
 * contrapartes definidas acá derivan sus movimientos sin conciliar a la tab
 * Consolidados → Proveedores.
 *
 * ⚠ REVISAR LA LISTA ANTES DE APLICAR: viene pre-cargada con las contrapartes
 * visibles en los pantallazos del 09-07-2026 (algunos nombres estaban truncados
 * en pantalla; los RUTs salen de las glosas). Editar/completar según el listado
 * real del negocio. También se puede administrar todo por la UI.
 *
 * Idempotente: upsert por RUT (o por nombre si no tiene RUT). Re-correrlo
 * actualiza nombre/patrones sin duplicar.
 *
 * Uso (en el SERVIDOR):
 *   npx tsx scripts/seed-proveedores.ts            # dry-run: muestra qué haría
 *   npx tsx scripts/seed-proveedores.ts --apply    # inserta/actualiza
 */
import { PrismaClient } from "@prisma/client";
import { normalizeRut } from "../src/lib/internos/detect";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

interface SeedProveedor {
  nombre: string;
  rut?: string; // con o sin puntos/guion, se normaliza
  patrones?: string[]; // respaldo para glosas sin RUT
  nota?: string;
}

// ============================================================================
// EDITAR ESTA LISTA — contrapartes de los pantallazos (verificar RUT/nombre):
// ============================================================================
const SEED: SeedProveedor[] = [
  {
    nombre: "KM10 AUDIOVISUAL SPA",
    rut: "77.935.126-2",
    patrones: ["KM10 AUDIOVISUAL"],
  },
  {
    nombre: "URIBE RIVAS, PERLA VERONICA",
    rut: "11.888.672-0",
  },
  {
    nombre: "PINEDO AYALA, DEISY MARI", // nombre truncado en pantalla — completar
    rut: "22.596.930-2",
  },
  {
    nombre: "ANA CIFUENTES", // truncado en pantalla ("ANA CIFUENT...") — completar
    rut: "17.417.326-5",
  },
  {
    nombre: "ROS PUIGMOLE, JULIA ANA",
    rut: "6.366.667-K",
  },
  {
    nombre: "STEPHANIE OCAYO",
    rut: "25.101.618-6",
  },
  {
    nombre: "SERGIO A", // truncado en pantalla — completar nombre real
    rut: "76.103.501-0",
  },
  {
    nombre: "JUAN SEPULVEDA", // sin RUT visible en la glosa → solo patrón
    patrones: ["JUAN SEPULV"],
    nota: "Glosa 'DEP.1180421 TESORERIA JUAN SEPULV...' — sin RUT; revisar patrón.",
  },
  {
    nombre: "COLCHAGUA TURI",
    patrones: ["COLCHAGUA TURI"],
    nota: "Del listado de asientos generados — agregar RUT si se conoce.",
  },
  {
    nombre: "TURISMO VYB",
    patrones: ["Turismo VYB"],
    nota: "Del listado de asientos generados — agregar RUT si se conoce.",
  },
  {
    nombre: "SERVICIOS DE T", // nombre que trunca el banco — completar razón social
    rut: "77.748.193-2",
    patrones: ["SERVICIOS DE T"],
  },
];
// ============================================================================

async function main() {
  console.log(`Seed ProveedorAsiento — ${APPLY ? "APPLY" : "DRY-RUN"} · ${SEED.length} proveedores\n`);

  for (const p of SEED) {
    const rut = p.rut ? normalizeRut(p.rut) : null;
    const patrones = (p.patrones ?? []).filter((s) => s.trim().length >= 3);
    if (!rut && patrones.length === 0) {
      console.log(`  ✗ SKIP    ${p.nombre} — sin RUT ni patrones, nunca matchearía`);
      continue;
    }

    const existing = rut
      ? await prisma.proveedorAsiento.findUnique({ where: { rut } })
      : await prisma.proveedorAsiento.findFirst({ where: { nombre: p.nombre } });

    if (!APPLY) {
      console.log(
        `  ${existing ? "~ UPDATE " : "+ CREAR  "}${p.nombre}  rut=${rut ?? "-"}  patrones=[${patrones.join(", ")}]`,
      );
      continue;
    }

    if (existing) {
      // Fusionar patrones sin duplicar (case-insensitive), conservar nota si no viene.
      const merged = Array.from(
        new Map([...existing.patrones, ...patrones].map((x) => [x.toLowerCase(), x])).values(),
      );
      await prisma.proveedorAsiento.update({
        where: { id: existing.id },
        data: { nombre: p.nombre, rut, patrones: merged, nota: p.nota ?? existing.nota, active: true },
      });
      console.log(`  ~ UPDATE  ${p.nombre} (patrones: ${existing.patrones.length} → ${merged.length})`);
    } else {
      await prisma.proveedorAsiento.create({
        data: { nombre: p.nombre, rut, patrones, nota: p.nota ?? null },
      });
      console.log(`  + CREADO  ${p.nombre}`);
    }
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] Nada insertado. Para aplicar:\n  npx tsx scripts/seed-proveedores.ts --apply`);
  } else {
    console.log(`\nListo. Revisá Consolidados → Proveedores: los pendientes que matchean ya deberían estar ahí.`);
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
