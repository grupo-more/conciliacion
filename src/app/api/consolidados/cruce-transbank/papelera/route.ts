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
 * Los apartados NO expiran: son restaurables siempre (decisión jul-2026; antes
 * había ventana de 30 días). `expiresAt` se sigue escribiendo solo como dato
 * histórico — nada lo consulta.
 *
 * GET    → lista los apartados.
 * POST   → apartar un par (lo manda a la papelera).
 * DELETE ?id=  → restaurar (vuelve a "por cuadrar").
 */

const DIAS_VENTANA = 30; // informativo: solo alimenta expiresAt (sin efecto)

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const rows = await prisma.cuadraturaTransbankApartado.findMany({
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
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
      // Sin expiración: todo apartado es restaurable mientras exista.
      recuperable: true,
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

  await prisma.cuadraturaTransbankApartado.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
