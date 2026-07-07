import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Vínculo MANUAL POS↔settlement en Cruce Transbank, para pares que el motor no
 * cuadra solo (sin llave común, monto no exacto, "ENVIO APP", etc.).
 *
 * POST {tbkTesoreriaId, transbankSaleId, nota?}  → crea el vínculo.
 * DELETE ?tbkTesoreriaId= | ?id=                 → lo deshace.
 */
const postSchema = z.object({
  tbkTesoreriaId: z.string().min(1),
  transbankSaleId: z.string().min(1),
  nota: z.string().trim().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "conciliar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { tbkTesoreriaId, transbankSaleId, nota } = parsed.data;

  // Validar que ambos lados existan.
  const [pos, sett] = await Promise.all([
    prisma.tbkTesoreria.findUnique({ where: { id: tbkTesoreriaId }, select: { id: true } }),
    prisma.transbankSale.findUnique({ where: { id: transbankSaleId }, select: { id: true } }),
  ]);
  if (!pos) return NextResponse.json({ error: "Movimiento POS no encontrado" }, { status: 404 });
  if (!sett) return NextResponse.json({ error: "Abono Transbank no encontrado" }, { status: 404 });

  try {
    const link = await prisma.cruceTransbankLink.create({
      data: { tbkTesoreriaId, transbankSaleId, nota: nota ?? null, createdById: session.sub },
    });
    return NextResponse.json({ ok: true, id: link.id }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "El POS o el abono ya está vinculado. Deshacé el vínculo existente primero." },
        { status: 409 },
      );
    }
    throw e;
  }
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "conciliar");
  if (deniedPerm) return deniedPerm;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const tbkTesoreriaId = url.searchParams.get("tbkTesoreriaId");
  if (!id && !tbkTesoreriaId) return NextResponse.json({ error: "Falta id o tbkTesoreriaId" }, { status: 400 });

  const where = id ? { id } : { tbkTesoreriaId: tbkTesoreriaId! };
  const link = await prisma.cruceTransbankLink.findUnique({ where });
  if (!link) return NextResponse.json({ error: "Vínculo no encontrado" }, { status: 404 });

  await prisma.cruceTransbankLink.delete({ where: { id: link.id } });
  return NextResponse.json({ ok: true });
}
