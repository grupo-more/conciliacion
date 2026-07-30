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

  const [posAll, settAll, manualLinks] = await Promise.all([
    prisma.tbkTesoreria.findMany({
      where: { fecha: { gte: from, lt: to }, estadoActual: { not: "ANU" } },
      orderBy: { fecha: "desc" },
    }),
    prisma.transbankSale.findMany({
      // Excluye los "Abonos conciliados" (ajenos a la empresa): tienen asiento
      // propio en su subtab, no entran a la cuadratura.
      where: { fechaVenta: { gte: from, lt: to }, abonoConciliadoAt: null },
      orderBy: { fechaVenta: "desc" },
    }),
    prisma.cruceTransbankLink.findMany({
      select: { tbkTesoreriaId: true, transbankSaleId: true },
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

  const { pairs } = matchCruce(posFree, settFree, manualLinks);

  const out: PendingPair[] = [];
  for (const p of pairs) {
    if (p.setts.length === 0) continue; // solo cuadrados
    if (opts.sucursalId != null && p.pos.sucursalId !== opts.sucursalId) continue;
    const posMonto = p.pos.monto < 0n ? -p.pos.monto : p.pos.monto;
    // Grupo 1:N (pago dividido): un item por settlement. El monto POS se reparte
    // para que la SUMA de los legs sea exactamente el POS (sin duplicar): cada
    // leg lleva su montoVenta y el primero absorbe el residuo (con 1 settlement
    // esto degenera al comportamiento 1:1 de siempre: leg único = monto POS).
    const restoVenta = p.setts.slice(1).reduce((acc, s) => acc + s.montoVenta, 0n);
    for (let i = 0; i < p.setts.length; i++) {
      const sett = p.setts[i];
      // Comisión de cartola (settlement, con IVA) → base del 1403.
      // Comisión de la API/Dynatech (con IVA, null en débito → 0) → rubro 708,
      // solo en el primer leg (es del POS, no del settlement: no se duplica).
      const comisionCartola = sett.comision + sett.ivaComision;
      const comisionApi = i === 0 ? p.pos.comisionMonto ?? 0n : 0n;
      out.push({
        tbkTesoreriaId: p.pos.id,
        transbankSaleId: sett.id,
        sucursalId: p.pos.sucursalId,
        sucursalName: sucByCodigo.get(p.pos.sucursalId) ?? p.pos.sucursalName ?? null,
        sucursalCodigo: sucByCodigo.has(p.pos.sucursalId) ? p.pos.sucursalId : null,
        montoDynatech: i === 0 ? posMonto - restoVenta : sett.montoVenta,
        montoTransbank: sett.totalAbono,
        montoComision: comisionCartola,
        montoComisionApi: comisionApi,
        // Detalle por movimiento (para el desglose y el snapshot al generar).
        fecha: p.pos.fecha.toISOString(),
        opBoleta: (p.setts.length === 1 ? p.pos.opNumber : null) ?? sett.numeroBoleta ?? null,
        medioPago: sett.medioPago ?? null,
        fechaPos: p.pos.fecha,
      });
    }
  }
  return out;
}
