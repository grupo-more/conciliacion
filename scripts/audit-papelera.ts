/**
 * Auditoría de la Papelera de cuadratura Transbank (CuadraturaTransbankApartado).
 *
 * Responde: ¿están los movimientos "antiguos" en la papelera o de verdad
 * faltan? Muestra totales, rangos de fechas (apartado vs movimiento),
 * distribución por mes, vencidos y los 30 movimientos más antiguos.
 *
 * Uso (donde esté el DATABASE_URL):
 *   npx tsx scripts/audit-papelera.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error"] });

const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : "—");

async function main() {
  const rows = await prisma.cuadraturaTransbankApartado.findMany({
    orderBy: { createdAt: "asc" },
  });
  const now = Date.now();

  // 1) Panorama general
  const conFecha = rows.filter((r) => r.fecha);
  const vencidos = rows.filter((r) => r.expiresAt.getTime() <= now);
  console.log("=== 1) PANORAMA GENERAL ===");
  console.log(`Total apartados:        ${rows.length}`);
  console.log(`Primer apartado:        ${d(rows[0]?.createdAt)}`);
  console.log(`Último apartado:        ${d(rows[rows.length - 1]?.createdAt)}`);
  const fechas = conFecha.map((r) => r.fecha!.getTime()).sort((a, b) => a - b);
  console.log(`Mov. más antiguo:       ${fechas.length ? d(new Date(fechas[0])) : "—"}`);
  console.log(`Mov. más nuevo:         ${fechas.length ? d(new Date(fechas[fechas.length - 1])) : "—"}`);
  console.log(`Sin fecha de mov.:      ${rows.length - conFecha.length}`);
  console.log(`Vencidos (definitivos): ${vencidos.length}`);
  console.log(`¿Sobre el límite 2000?: ${rows.length > 2000 ? "SÍ — el API recorta" : "no"}`);

  // 2) Distribución mes apartado vs mes movimiento
  console.log("\n=== 2) MES APARTADO vs MES MOVIMIENTO (n | suma dynatech) ===");
  const dist = new Map<string, { n: number; suma: bigint }>();
  for (const r of rows) {
    const key = `${r.createdAt.toISOString().slice(0, 7)}  ←  ${r.fecha ? r.fecha.toISOString().slice(0, 7) : "sin fecha"}`;
    const e = dist.get(key) ?? { n: 0, suma: 0n };
    e.n++;
    e.suma += r.montoDynatech;
    dist.set(key, e);
  }
  for (const [key, e] of [...dist.entries()].sort()) {
    console.log(`  ${key}   n=${e.n}   $${e.suma}`);
  }

  // 3) Los 30 movimientos más antiguos (por fecha de MOVIMIENTO)
  console.log("\n=== 3) LOS 30 MOVIMIENTOS MÁS ANTIGUOS (por fecha de mov.) ===");
  console.log("fecha_mov | apartado_el | sucursal | op/boleta | dynatech | transbank | recuperable_hasta | ¿aún?");
  const antiguos = [...conFecha].sort((a, b) => a.fecha!.getTime() - b.fecha!.getTime()).slice(0, 30);
  for (const r of antiguos) {
    console.log(
      `${d(r.fecha)} | ${d(r.createdAt)} | ${r.sucursalName ?? "#" + r.sucursalId} | ${r.opBoleta ?? "—"} | $${r.montoDynatech} | $${r.montoTransbank} | ${d(r.expiresAt)} | ${r.expiresAt.getTime() > now ? "sí" : "NO (definitivo)"}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
