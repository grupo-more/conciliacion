/**
 * Lista COMPLETAS las ventas Crédito con comisión $0 (las 10 filas sin TID/
 * autorización/boleta que no parecen ventas reales), con todos sus campos para
 * mirarlas juntas y decidir qué son.
 *
 * Uso (EN EL SERVER):
 *   npx tsx scripts/diag-listar-credito-cero.ts
 */

import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.transbankSale.findMany({
      where: { medioPago: { contains: "rédito" }, comision: 0n, ivaComision: 0n },
      orderBy: { fechaVenta: "asc" },
    });

    console.log(`Crédito con comisión $0: ${rows.length}\n`);
    rows.forEach((s, i) => {
      const raw = s.rawRow as Record<string, unknown> | null;
      console.log(`#${i + 1} ─────────────────────────────────────────────`);
      console.log(`  Fecha venta:   ${s.fechaVenta.toISOString().slice(0, 10)}`);
      console.log(`  Local:         ${s.nombreLocal}  (sucursalId=${s.sucursalId ?? "—"})`);
      console.log(`  Cód. comercio: ${s.codigoComercio}`);
      console.log(`  Medio:         ${s.medioPago}`);
      console.log(`  Bruto:         ${s.montoVenta}`);
      console.log(`  Comisión+IVA:  ${s.comision} + ${s.ivaComision}`);
      console.log(`  Total abono:   ${s.totalAbono}`);
      console.log(`  N° boleta:     ${s.numeroBoleta ?? "—"}`);
      console.log(`  TID:           ${s.tid ?? "—"}`);
      console.log(`  Cód. autoriz.: ${s.codigoAutorizacion ?? "—"}`);
      console.log(`  Número único:  ${s.numeroUnico}`);
      console.log(`  Tarjeta:       ${raw?.["N° de tarjeta"] ?? "—"}`);
      console.log(`  Monto válido abono: ${raw?.["Monto venta válido para abono (+)"] ?? "—"}`);
      console.log(`  Tipo venta/cuota:   ${raw?.["Tipo de venta/cuota"] ?? "—"}`);
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
