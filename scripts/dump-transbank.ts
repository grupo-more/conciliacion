/**
 * Dump de las tablas del Cruce Transbank para análisis: TbkTesoreria (POS,
 * /api/tbk-tesoreria) + TransbankSale (settlement .xls "Abonos por día").
 *
 * Incluye rawJson / rawRow COMPLETOS para detectar campos que aún no estamos
 * mapeando y mejorar el match.
 *
 * Uso (EN EL SERVER, con DATABASE_URL apuntando a la base real):
 *   npx tsx scripts/dump-transbank.ts
 *
 * Salida: dumps/transbank_dump_<YYYY-MM-DD>.json   (gitignored)
 * Después copialo a la carpeta dump/ (o dumps/) de tu máquina local y avisame.
 */

import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync } from "fs";
import { resolve } from "path";

const prisma = new PrismaClient({ log: ["error", "warn"] });
const TAKE = 100_000;

async function main() {
  const dumpsDir = resolve(process.cwd(), "dumps");
  if (!existsSync(dumpsDir)) mkdirSync(dumpsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(dumpsDir, `transbank_dump_${today}.json`);

  const [pos, sales, imports] = await Promise.all([
    prisma.tbkTesoreria.findMany({ take: TAKE, orderBy: { fecha: "desc" } }),
    prisma.transbankSale.findMany({ take: TAKE, orderBy: { fechaVenta: "desc" } }),
    prisma.transbankImport.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  // Rango de fechas por fuente
  const range = (arr: Date[]) => {
    if (!arr.length) return null;
    const t = arr.map((d) => d.getTime());
    return { min: new Date(Math.min(...t)).toISOString().slice(0, 10), max: new Date(Math.max(...t)).toISOString().slice(0, 10) };
  };

  const dump = {
    generatedAt: new Date().toISOString(),
    counts: {
      tbkTesoreria: pos.length,
      transbankSale: sales.length,
      transbankImport: imports.length,
    },
    ranges: {
      tbkTesoreria: range(pos.map((p) => p.fecha)),
      transbankSale: range(sales.map((s) => s.fechaVenta)),
    },
    // Sucursales vistas en cada fuente
    sucursalesPos: [...new Set(pos.map((p) => `${p.sucursalId}:${p.sucursalName ?? ""}`))],
    sucursalesSaleResueltas: [...new Set(sales.map((s) => String(s.sucursalId)))],
    mediosPago: [...new Set(sales.map((s) => s.medioPago))],
    tiposMovimiento: [...new Set(sales.map((s) => s.tipoMovimiento))],
    // Boletas en POS (opNumber) y settlement (numeroBoleta) para diagnosticar match
    posSinOpNumber: pos.filter((p) => !p.opNumber).length,
    saleSinBoleta: sales.filter((s) => !s.numeroBoleta).length,
    saleConAnulacion: sales.filter((s) => s.montoAnulado && s.montoAnulado !== 0n).length,

    transbankImport: imports.map((i) => ({
      fileName: i.fileName, empresaRut: i.empresaRut, cuentaAbono: i.cuentaAbono,
      rowsTotal: i.rowsTotal, rowsInserted: i.rowsInserted, createdAt: i.createdAt,
    })),
    tbkTesoreria: pos.map((p) => ({
      externalId: p.externalId, sucursalId: p.sucursalId, sucursalName: p.sucursalName,
      cajeroUsername: p.cajeroUsername, cajeroName: p.cajeroName,
      glosa: p.glosa, opNumber: p.opNumber, fecha: p.fecha, monto: p.monto,
      folio: p.folio, rubro: p.rubro, tipo: p.tipo,
      clienteName: p.clienteName, clienteRut: p.clienteRut,
      rawJson: p.rawJson, // crudo de la API: detectar campos no mapeados
    })),
    transbankSale: sales.map((s) => ({
      fechaVenta: s.fechaVenta, tipoMovimiento: s.tipoMovimiento,
      codigoComercio: s.codigoComercio, nombreLocal: s.nombreLocal, sucursalId: s.sucursalId,
      medioPago: s.medioPago, montoVenta: s.montoVenta, comision: s.comision,
      ivaComision: s.ivaComision, totalAbono: s.totalAbono,
      fechaAnulacion: s.fechaAnulacion, montoAnulado: s.montoAnulado,
      numeroUnico: s.numeroUnico, tid: s.tid, codigoAutorizacion: s.codigoAutorizacion,
      numeroBoleta: s.numeroBoleta,
      rawRow: s.rawRow, // crudo del .xls: TODAS las columnas (anulación, cobros, tarjeta...)
    })),
  };

  const json = JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(outPath, json, "utf8");

  console.log("=".repeat(60));
  console.log("DUMP TRANSBANK (POS + settlement)");
  console.log("=".repeat(60));
  console.log(JSON.stringify(dump.counts, null, 2));
  console.log("Rangos:", JSON.stringify(dump.ranges));
  console.log("POS sin opNumber:", dump.posSinOpNumber, "| settlement sin boleta:", dump.saleSinBoleta, "| con anulación:", dump.saleConAnulacion);
  console.log(`\nArchivo: ${outPath}`);
  console.log("Copialo a dump/ en tu máquina local y avisame.");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR:", e);
  prisma.$disconnect();
  process.exit(1);
});
