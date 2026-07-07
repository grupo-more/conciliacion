import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Papelera de la cuadratura Transbank: pares cuadrados apartados para que NO
 * entren al asiento. Mientras el row exista, el par queda fuera de "por cuadrar".
 *
 * GET    → lista los apartados (con flag recuperable según expiresAt).
 * POST   → apartar un par (lo manda a la papelera, 30 días de ventana).
 * DELETE ?id=  → restaurar (solo dentro de la ventana; vuelve a "por cuadrar").
 */

const DIAS_VENTANA = 30;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const rows = await prisma.cuadraturaTransbankApartado.findMany({
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const now = Date.now();
  return NextResponse.json({
    apartados: rows.map((r) => ({
      id: r.id,
      sucursalId: r.sucursalId,
      sucursalName: r.sucursalName,
      sucursalCodigo: r.sucursalCodigo,
      fecha: r.fecha ? r.fecha.toISOString() : null,
      opBoleta: r.opBoleta,
      medioPago: r.medioPago,
      montoDynatech: r.montoDynatech.toString(),
      montoTransbank: r.montoTransbank.toString(),
      montoComision: r.montoComision.toString(),
      motivo: r.motivo,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      recuperable: r.expiresAt.getTime() > now,
    })),
  });
}

const postSchema = z.object({
  tbkTesoreriaId: z.string().min(1),
  transbankSaleId: z.string().min(1),
  sucursalId: z.number().int(),
  sucursalName: z.string().nullable().optional(),
  sucursalCodigo: z.number().int().nullable().optional(),
  fecha: z.string().nullable().optional(),
  opBoleta: z.string().nullable().optional(),
  medioPago: z.string().nullable().optional(),
  montoDynatech: z.string().regex(/^-?\d+$/),
  montoTransbank: z.string().regex(/^-?\d+$/),
  montoComision: z.string().regex(/^-?\d+$/),
  motivo: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "depurar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + DIAS_VENTANA);

  try {
    const created = await prisma.cuadraturaTransbankApartado.create({
      data: {
        tbkTesoreriaId: d.tbkTesoreriaId,
        transbankSaleId: d.transbankSaleId,
        sucursalId: d.sucursalId,
        sucursalName: d.sucursalName ?? null,
        sucursalCodigo: d.sucursalCodigo ?? null,
        fecha: d.fecha ? new Date(d.fecha) : null,
        opBoleta: d.opBoleta ?? null,
        medioPago: d.medioPago ?? null,
        montoDynatech: BigInt(d.montoDynatech),
        montoTransbank: BigInt(d.montoTransbank),
        montoComision: BigInt(d.montoComision),
        motivo: d.motivo ?? null,
        createdById: session.sub,
        expiresAt,
      },
    });
    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "Ese movimiento ya está en la papelera." }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "depurar");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });

  const row = await prisma.cuadraturaTransbankApartado.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  // Pasada la ventana, el apartado es definitivo: ya no se puede restaurar.
  if (row.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "Venció la ventana de restauración. Este apartado es definitivo." },
      { status: 409 },
    );
  }

  await prisma.cuadraturaTransbankApartado.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
