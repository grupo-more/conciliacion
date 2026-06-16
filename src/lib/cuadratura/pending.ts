import { prisma } from "@/lib/db";
import { matchCruce } from "@/lib/transbank/cruce";
import type { CuadraturaItemInput } from "./asiento";

export interface PendingPair extends CuadraturaItemInput {
  tbkTesoreriaId: string;
  transbankSaleId: string;
  fechaPos: Date; // fecha del POS (Dynatech), para el rango/snapshot
}

/**
 * Pares POS↔settlement CUADRADOS en [from, to) que todavía NO entraron a una
 * cuadratura (no consumidos). Es la base tanto del preview del asiento como de
 * la generación. Resuelve sucursal (nombre + código "Registro Dynatech") contra
 * el maestro Sucursal (Sucursal.codigo == TbkTesoreria.sucursalId).
 */
export async function getPendingPairs(
  from: Date,
  to: Date,
  opts: { sucursalId?: number | null } = {},
): Promise<PendingPair[]> {
  // Ids ya consumidos por cuadraturas previas + apartados en la papelera (cada
  // lado es único). Ambos quedan fuera de "por cuadrar".
  const [consumed, apartados] = await Promise.all([
    prisma.cuadraturaTransbankItem.findMany({
      select: { tbkTesoreriaId: true, transbankSaleId: true },
    }),
    prisma.cuadraturaTransbankApartado.findMany({
      select: { tbkTesoreriaId: true, transbankSaleId: true },
    }),
  ]);
  const usedPos = new Set([...consumed, ...apartados].map((c) => c.tbkTesoreriaId));
  const usedSett = new Set([...consumed, ...apartados].map((c) => c.transbankSaleId));

  const [posAll, settAll] = await Promise.all([
    prisma.tbkTesoreria.findMany({
      where: { fecha: { gte: from, lt: to }, estadoActual: { not: "ANU" } },
      orderBy: { fecha: "desc" },
    }),
    prisma.transbankSale.findMany({
      where: { fechaVenta: { gte: from, lt: to } },
      orderBy: { fechaVenta: "desc" },
    }),
  ]);

  const posFree = posAll.filter((p) => !usedPos.has(p.id));
  const settFree = settAll.filter((s) => !usedSett.has(s.id));

  // Maestro de sucursales: código (= sucursalId de Dynatech) → nombre.
  const sucRows = await prisma.sucursal.findMany({
    where: { codigo: { not: null } },
    select: { codigo: true, nombre: true },
  });
  const sucByCodigo = new Map<number, string>();
  for (const s of sucRows) if (s.codigo != null) sucByCodigo.set(s.codigo, s.nombre);

  const { pairs } = matchCruce(posFree, settFree);

  const out: PendingPair[] = [];
  for (const p of pairs) {
    if (!p.sett) continue; // solo cuadrados
    if (opts.sucursalId != null && p.pos.sucursalId !== opts.sucursalId) continue;
    const comision = p.sett.comision + p.sett.ivaComision;
    out.push({
      tbkTesoreriaId: p.pos.id,
      transbankSaleId: p.sett.id,
      sucursalId: p.pos.sucursalId,
      sucursalName: sucByCodigo.get(p.pos.sucursalId) ?? p.pos.sucursalName ?? null,
      sucursalCodigo: sucByCodigo.has(p.pos.sucursalId) ? p.pos.sucursalId : null,
      montoDynatech: p.pos.monto < 0n ? -p.pos.monto : p.pos.monto,
      montoTransbank: p.sett.totalAbono,
      montoComision: comision,
      // Detalle por movimiento (para el desglose y el snapshot al generar).
      fecha: p.pos.fecha.toISOString(),
      opBoleta: p.pos.opNumber ?? p.sett.numeroBoleta ?? null,
      medioPago: p.sett.medioPago ?? null,
      fechaPos: p.pos.fecha,
    });
  }
  return out;
}
