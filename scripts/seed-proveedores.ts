/**
 * Seed del maestro ProveedorAsiento (Configuración → Proveedores): las
 * contrapartes definidas acá derivan sus movimientos sin conciliar a la tab
 * Consolidados → Proveedores.
 *
 * Lista oficial de proveedores (planilla del 09-07-2026, 44 + 5 internos
 * excluidos). El match principal es por RUT (certero). Los patrones de texto
 * se pueden agregar después por la UI para los bancos que no informan RUT
 * (ej. Banco de Chile "Traspaso A: <nombre>").
 *
 * Idempotente: upsert por RUT (o por nombre si no tiene RUT). Re-correrlo
 * actualiza nombre/nota sin duplicar y conserva los patrones agregados por UI.
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
  patrones?: string[];
  nota?: string;
}

const SEED: SeedProveedor[] = [
  // ── Arriendos sucursales / estacionamientos / bodegas ──────────────────
  { nombre: "Inversiones Santa Paula S.A.", rut: "88.540.900-8", nota: "Arriendo Suc Patronato" },
  { nombre: "Raul del Canto Hidalgo", rut: "5.779.773-8", nota: "Arriendo Suc Valpo" },
  { nombre: "Alquimia Spa", rut: "76.103.501-0", nota: "Arriendo Estac 3 y 4" },
  { nombre: "Maria del Carmen Viollier", rut: "9.900.546-7", nota: "Arriendo Estac 9 y 10" },
  { nombre: "William Araya", rut: "10.341.186-6", nota: "Arriendo Depto Williams Araya IQQ" },
  { nombre: "Maria Teresa Fuentes", rut: "6.854.158-1", nota: "Arriendo Suc Iquique" },
  { nombre: "Victor Vera Urtubia e Hijos Limitada", rut: "76.101.048-4", nota: "Arriendo Suc Viña" },
  { nombre: "Valentina Gonzalez Navarrete", rut: "9.004.469-9", nota: "Arriendo Suc Suecia" },
  { nombre: "Inmobiliaria San Antonio Limitada", rut: "78.828.370-9", nota: "Arriendo Suc Bosque" },
  { nombre: "Javier Hurtado Salas Spa", rut: "86.646.300-K", nota: "Arriendo OF 206 More Capital SpA" },
  { nombre: "Elizabeth Bennett", rut: "8.208.990-K", nota: "Arriendo San Sebastian" },
  { nombre: "Inversiones y Bodegas las Torres Spa", rut: "76.731.964-9", nota: "Bodega" },
  { nombre: "Clara Michel", rut: "12.127.837-5", nota: "Bodega Ebro" },
  // ── Malls / totems ──────────────────────────────────────────────────────
  { nombre: "Parque Arauco S.A.", rut: "94.627.000-8", nota: "Arriendo Totem-Local-Electricidad" },
  { nombre: "Adm De Centros Comerciales Cencosud Spa", rut: "78.408.990-8", nota: "Gastos comunes publicidad y promocion totems PLD ALC PÑÑ" },
  { nombre: "Cencosud Shopping SA", rut: "76.433.310-1", nota: "Arriendos totems PLD ALC PÑÑ" },
  { nombre: "Comercializadora Costanera Center Spa", rut: "76.203.299-6", nota: "Arriendo totems costanera" },
  { nombre: "Inversiones Las Arenas", rut: "99.507.730-2", nota: "Arriendo Totem Patio Bellavista" },
  { nombre: "Plaza Oeste SpA", rut: "96.653.650-0", nota: "Arriendo Totem Plaza Egaña" },
  { nombre: "Inmobiliaria Mall Viña del Mar S.A.", rut: "96.863.570-0", nota: "Arriendo totem mall marina" },
  // ── Importaciones / rendiciones ─────────────────────────────────────────
  { nombre: "Miguel Marcelo Alvarez Ponce", rut: "10.462.720-K", nota: "Rendicion Importaciones" },
  { nombre: "Eddy Alvarez", rut: "11.945.497-2", nota: "Rendicion Importaciones" },
  { nombre: "Mario Alvarez", rut: "12.604.733-9", nota: "Rendicion Importaciones" },
  { nombre: "Enrique Bergel", rut: "24.996.496-4", nota: "Rendicion Importaciones" },
  { nombre: "Agencia de Aduana Bruno Perinetti y Cia. Ltda", rut: "78.023.750-3", nota: "Importaciones" },
  // ── Servicios / gastos ──────────────────────────────────────────────────
  { nombre: "Oscar Avendaño Jarry", rut: "7.817.023-9", nota: "Pago BH. Asesoria en Materia de Cumplimiento UAF" },
  { nombre: "Sociedad Comercial Kowen Ltda", rut: "76.599.172-2", nota: "Proveedor de Agua Purificada" },
  { nombre: "Servicios Setrac Limitada", rut: "78.816.940-K", nota: "Servicios Totem" },
  { nombre: "Comercializadora Todoclick Spa", rut: "76.977.985-K", nota: "Compra de notebooks y relacionados" },
  { nombre: "Gibli Activadora de Negocios Spa", rut: "76.713.453-0", nota: "Marketing" },
  { nombre: "Comunidad Edificio Centroprofesional IV", rut: "56.014.440-7", nota: "Gasto comun More Capital - Matriz" },
  { nombre: "Andres Lea Plaza", rut: "16.660.356-0", nota: "Servicios Profesionales Abogado" },
  { nombre: "Victor Segundo Godoy Aranda", rut: "9.901.096-7", nota: "BH Servicios Cerrajeria" },
  { nombre: "Tejesoft Spa", rut: "76.615.922-2", nota: "Servicios Informaticos" },
  { nombre: "Superline Spa", rut: "77.241.092-1", nota: "Proveedor Insumo oficina" },
  { nombre: "Martin Sanhueza Carcamo", rut: "19.670.534-1", nota: "Pagos Totem" },
  { nombre: "Chubb Seguros de Vida Chile SA", rut: "99.588.060-1", nota: "Seguro complementario Salud" },
  { nombre: "Aseguradora Porvenir", rut: "76.598.625-7", nota: "Seguros Locales" },
  { nombre: "Brinks Chile", rut: "86.431.800-2", nota: "Valores" },
  { nombre: "Alfabot Spa", rut: "77.014.491-4", nota: "Servicios Profesionales" },
  { nombre: "Rolando Fernandez", rut: "17.282.249-5", nota: "Reembolsos y FXR" },
  { nombre: "M&J Consultores Spa", rut: "76.951.774-K", nota: "Servicios Profesionales" },
  { nombre: "Andrea Espindola", rut: "9.607.114-0", nota: "BH Servicios Profesionales" },
  { nombre: "Comercializadora Nueva Aliada Limitada", rut: "76.302.362-1", nota: "Publicidad" },

  // ── EXCLUIDOS A PROPÓSITO: entidades internas ("Traspasos bancos") ──────
  // Me Spa (77.333.096-4), Mg Spa (77.333.097-2), More Capital Spa
  // (76.815.928-9), More Exchange Spa (76.611.709-0) y More Giros Spa
  // (77.333.099-9) están en la planilla, pero son ENTIDADES INTERNAS: sus
  // traspasos los maneja Consolidados → Traspasos internos (matcher espejo
  // OUT↔IN). Meterlas acá derivaría sus huérfanos a la tab Proveedores y
  // duplicaría flujos. Si de verdad se quieren acá, descomentar:
  // { nombre: "Me Spa", rut: "77.333.096-4", nota: "Traspasos bancos" },
  // { nombre: "Mg Spa", rut: "77.333.097-2", nota: "Traspasos bancos" },
  // { nombre: "More Capital Spa", rut: "76.815.928-9", nota: "Traspasos bancos" },
  // { nombre: "More Exchange Spa", rut: "76.611.709-0", nota: "Traspasos bancos" },
  // { nombre: "More Giros Spa", rut: "77.333.099-9", nota: "Traspasos bancos" },
];

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
        `  ${existing ? "~ UPDATE " : "+ CREAR  "}${p.nombre}  rut=${rut ?? "-"}${patrones.length ? `  patrones=[${patrones.join(", ")}]` : ""}`,
      );
      continue;
    }

    if (existing) {
      // Fusionar patrones sin duplicar (case-insensitive) — conserva los
      // agregados por UI. La nota del seed pisa solo si el existente no tiene.
      const merged = Array.from(
        new Map([...existing.patrones, ...patrones].map((x) => [x.toLowerCase(), x])).values(),
      );
      await prisma.proveedorAsiento.update({
        where: { id: existing.id },
        data: { nombre: p.nombre, rut, patrones: merged, nota: existing.nota ?? p.nota ?? null, active: true },
      });
      console.log(`  ~ UPDATE  ${p.nombre}`);
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
