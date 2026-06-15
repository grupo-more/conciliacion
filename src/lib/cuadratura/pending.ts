import { prisma } from "@/lib/db";
import { matchCruce } from "@/lib/transbank/cruce";
import type { CuadraturaItemInput } from "./asiento";

export interface PendingPair extends CuadraturaItemInput {
  tbkTesoreriaId: string;
  transbankSaleId: string;
  fecha: Date; // fecha del POS (Dynatech)
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
  // Ids ya consumidos por cuadraturas previas (cada lado es único).
  const consumed = await prisma.cuadraturaTransbankItem.findMany({
    select: { tbkTesoreriaId: true, transbankSaleId: true },
  });
  const usedPos = new Set(consumed.map((c) => c.tbkTesoreriaId));
  const usedSett = new Set(consumed.map((c) => c.transbankSaleId));

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
      fecha: p.pos.fecha,
    });
  }
  return out;
}
