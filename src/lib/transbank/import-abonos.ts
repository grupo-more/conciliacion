import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import {
  parseTransbankAbonos,
  resolveSucursal,
  type TransbankSaleParsed,
} from "./parse-abonos";

export interface TransbankImportResult {
  ok: boolean;
  dryRun: boolean;
  fileName: string;
  empresaRut: string | null;
  cuentaAbono: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  totals: {
    fileRows: number;
    toInsert: number;
    duplicates: number;
    parseErrors: number;
  };
  alreadyImported?: { importedAt: string; importId: string };
  sampleSales: Array<{
    fechaVenta: string;
    nombreLocal: string;
    sucursalId: number | null;
    medioPago: string;
    montoVenta: string;
    comision: string;
    totalAbono: string;
    numeroBoleta: string | null;
    status: "NEW" | "DUP";
  }>;
  inserted?: { importId: string; rowsInserted: number };
  error?: string;
}

interface RunOpts {
  fileName: string;
  fileBuffer: Buffer;
  dryRun: boolean;
}

export async function importTransbankAbonos(opts: RunOpts): Promise<TransbankImportResult> {
  const { fileName, fileBuffer, dryRun } = opts;
  const fileHash = createHash("sha256").update(fileBuffer).digest("hex");

  const parsed = parseTransbankAbonos(fileBuffer);

  // Catalogo de sucursales para resolver nombreLocal -> id.
  const sucRows = await prisma.tesoreriaMovement.groupBy({
    by: ["sucursalId", "sucursalName"],
  });
  const catalog = sucRows
    .filter((r) => r.sucursalName)
    .map((r) => ({ id: r.sucursalId, name: r.sucursalName as string }));

  const previous = await prisma.transbankImport.findUnique({ where: { fileHash } });

  // Dedup por numeroUnico (global; el numero unico de Transbank es estable).
  const numeros = parsed.sales.map((sv) => sv.numeroUnico);
  const existing = numeros.length
    ? await prisma.transbankSale.findMany({
        where: { numeroUnico: { in: numeros } },
        select: { numeroUnico: true },
      })
    : [];
  const existingSet = new Set(existing.map((e) => e.numeroUnico));

  const withStatus = parsed.sales.map((sv) => ({
    sv,
    sucursalId: resolveSucursal(sv.nombreLocal, catalog),
    isDup: existingSet.has(sv.numeroUnico),
  }));
  const news = withStatus.filter((x) => !x.isDup);

  const result: TransbankImportResult = {
    ok: true,
    dryRun,
    fileName,
    empresaRut: parsed.empresaRut,
    cuentaAbono: parsed.cuentaAbono,
    periodFrom: parsed.periodFrom?.toISOString() ?? null,
    periodTo: parsed.periodTo?.toISOString() ?? null,
    totals: {
      fileRows: parsed.sales.length,
      toInsert: news.length,
      duplicates: withStatus.length - news.length,
      parseErrors: parsed.errors.length,
    },
    alreadyImported: previous
      ? { importedAt: previous.createdAt.toISOString(), importId: previous.id }
      : undefined,
    sampleSales: withStatus.slice(0, 50).map((x) => ({
      fechaVenta: x.sv.fechaVenta.toISOString(),
      nombreLocal: x.sv.nombreLocal,
      sucursalId: x.sucursalId,
      medioPago: x.sv.medioPago,
      montoVenta: String(x.sv.montoVenta),
      comision: String(x.sv.comision + x.sv.ivaComision),
      totalAbono: String(x.sv.totalAbono),
      numeroBoleta: x.sv.numeroBoleta,
      status: x.isDup ? "DUP" : "NEW",
    })),
  };

  if (dryRun) return result;
  if (previous) {
    // Mismo archivo ya importado: no recreamos. (numeroUnico igual los blinda).
    result.inserted = { importId: previous.id, rowsInserted: 0 };
    return result;
  }

  const imp = await prisma.$transaction(async (tx) => {
    const created = await tx.transbankImport.create({
      data: {
        fileName,
        fileHash,
        empresaRut: parsed.empresaRut,
        cuentaAbono: parsed.cuentaAbono,
        periodFrom: parsed.periodFrom,
        periodTo: parsed.periodTo,
        rowsTotal: parsed.sales.length,
        rowsInserted: news.length,
        rowsDuplicated: withStatus.length - news.length,
      },
    });
    if (news.length > 0) {
      await tx.transbankSale.createMany({
        data: news.map((x) => saleData(created.id, x.sv, x.sucursalId)),
        skipDuplicates: true,
      });
    }
    return created;
  });

  result.inserted = { importId: imp.id, rowsInserted: news.length };
  return result;
}

function saleData(importId: string, sv: TransbankSaleParsed, sucursalId: number | null) {
  return {
    importId,
    fechaVenta: sv.fechaVenta,
    tipoMovimiento: sv.tipoMovimiento,
    codigoComercio: sv.codigoComercio,
    nombreLocal: sv.nombreLocal,
    sucursalId,
    medioPago: sv.medioPago,
    montoVenta: BigInt(sv.montoVenta),
    comision: BigInt(sv.comision),
    ivaComision: BigInt(sv.ivaComision),
    totalAbono: BigInt(sv.totalAbono),
    fechaAnulacion: sv.fechaAnulacion,
    montoAnulado: BigInt(sv.montoAnulado),
    numeroUnico: sv.numeroUnico,
    tid: sv.tid,
    codigoAutorizacion: sv.codigoAutorizacion,
    numeroBoleta: sv.numeroBoleta,
    rawRow: sv.rawRow as object,
  };
}
