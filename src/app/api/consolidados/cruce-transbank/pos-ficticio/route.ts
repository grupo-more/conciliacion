import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POS FICTICIO para Cruce Transbank: crea un TbkTesoreria insertado a mano (no
 * viene de la API) y lo vincula a un abono Transbank "sin POS". Sirve cuando la
 * venta no la registró la API (ej. pago parte tarjeta + parte efectivo): se
 * simula el POS de la parte tarjeta para que el abono quede cuadrado.
 *
 * El externalId es NEGATIVO (la API manda positivos), así el sync nunca lo pisa.
 * manual=true lo distingue (badge) y lo excluye de los totales de ventas reales.
 *
 * POST {transbankSaleId, sucursalId, fecha, monto, opNumber?, glosa?, medioPago?, nota?}
 *   → crea el POS ficticio + CruceTransbankLink (transacción).
 * DELETE ?tbkTesoreriaId=  → borra el vínculo y, si el POS es ficticio, el POS.
 */
const postSchema = z.object({
  transbankSaleId: z.string().min(1),
  sucursalId: z.number().int(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monto: z.number().int(), // bruto (CLP), positivo
  opNumber: z.string().trim().max(60).nullable().optional(),
  glosa: z.string().trim().max(500).nullable().optional(),
  medioPago: z.string().trim().max(40).nullable().optional(),
  nota: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { transbankSaleId, sucursalId, fecha, monto, opNumber, glosa, medioPago, nota } = parsed.data;

  const sett = await prisma.transbankSale.findUnique({
    where: { id: transbankSaleId },
    select: { id: true },
  });
  if (!sett) return NextResponse.json({ error: "Abono Transbank no encontrado" }, { status: 404 });

  // sucursalId es la convención POS/settlement (2-10), NO el código del maestro.
  // El nombre limpio se toma de un registro REAL de esa sucursalId (POS real o
  // Tesorería); NUNCA del nombreLocal del settlement (es la dirección) ni del
  // maestro (otra convención + mezcla rubros). Si no hay, queda null y las vistas
  // lo resuelven por sucName.
  const refName =
    (
      await prisma.tbkTesoreria.findFirst({
        where: { sucursalId, manual: false, sucursalName: { not: null } },
        select: { sucursalName: true },
      })
    )?.sucursalName ??
    (
      await prisma.tesoreriaMovement.findFirst({
        where: { sucursalId, sucursalName: { not: null } },
        select: { sucursalName: true },
      })
    )?.sucursalName ??
    null;

  const [y, m, dd] = fecha.split("-").map(Number);
  const fechaDate = new Date(y, m - 1, dd, 12, 0, 0, 0);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // externalId sintético: menor que cualquiera existente y < 0.
      const agg = await tx.tbkTesoreria.aggregate({ _min: { externalId: true } });
      const minId = agg._min.externalId ?? 0n;
      const externalId = (minId < 0n ? minId : 0n) - 1n;

      const pos = await tx.tbkTesoreria.create({
        data: {
          externalId,
          sucursalId,
          sucursalName: refName,
          glosa: glosa?.trim() || "POS MANUAL (ficticio)",
          opNumber: opNumber?.trim() || null,
          fecha: fechaDate,
          monto: BigInt(monto),
          tipo: "TBK",
          estadoActual: "CAJ",
          estadoOriginal: "CAJ",
          manual: true,
          manualNota: nota?.trim() || null,
          createdById: session.sub,
          rawJson: { manual: true, source: "pos-ficticio", medioPago: medioPago ?? null },
        },
      });

      const link = await tx.cruceTransbankLink.create({
        data: {
          tbkTesoreriaId: pos.id,
          transbankSaleId,
          nota: nota?.trim() || "POS ficticio (manual)",
          createdById: session.sub,
        },
      });
      return { posId: pos.id, linkId: link.id };
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "Ese abono ya está vinculado. Deshacé el vínculo existente primero." },
        { status: 409 },
      );
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const tbkTesoreriaId = new URL(req.url).searchParams.get("tbkTesoreriaId");
  if (!tbkTesoreriaId) return NextResponse.json({ error: "Falta tbkTesoreriaId" }, { status: 400 });

  const pos = await prisma.tbkTesoreria.findUnique({
    where: { id: tbkTesoreriaId },
    select: { id: true, manual: true },
  });
  if (!pos) return NextResponse.json({ error: "POS no encontrado" }, { status: 404 });
  if (!pos.manual) {
    return NextResponse.json(
      { error: "Este POS no es ficticio: no se puede borrar (solo desvincular)." },
      { status: 400 },
    );
  }

  // Borra el vínculo (si existe) y el POS ficticio.
  await prisma.$transaction(async (tx) => {
    await tx.cruceTransbankLink.deleteMany({ where: { tbkTesoreriaId } });
    await tx.tbkTesoreria.delete({ where: { id: tbkTesoreriaId } });
  });
  return NextResponse.json({ ok: true });
}
