import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Vínculo MANUAL POS↔settlement en Cruce Transbank, para pares que el motor no
 * cuadra solo (sin llave común, monto no exacto, "ENVIO APP", etc.).
 * Soporta 1:N — un POS puede vincularse a VARIOS abonos (giro pagado en 2+
 * transacciones de tarjeta); cada abono pertenece a lo sumo a un POS.
 *
 * POST {tbkTesoreriaId, transbankSaleIds: string[], nota?}  → crea los vínculos.
 *      (acepta también transbankSaleId único, por compatibilidad)
 * DELETE ?tbkTesoreriaId= → deshace TODOS los vínculos de ese POS (el grupo).
 * DELETE ?id=             → deshace un vínculo puntual.
 */
const postSchema = z
  .object({
    tbkTesoreriaId: z.string().min(1),
    transbankSaleId: z.string().min(1).optional(),
    transbankSaleIds: z.array(z.string().min(1)).min(1).max(20).optional(),
    nota: z.string().trim().max(500).nullable().optional(),
  })
  .refine((d) => d.transbankSaleId || d.transbankSaleIds?.length, {
    message: "Falta transbankSaleId(s)",
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
  const { tbkTesoreriaId, nota } = parsed.data;
  const settIds = Array.from(
    new Set(parsed.data.transbankSaleIds ?? [parsed.data.transbankSaleId!]),
  );

  // Validar que ambos lados existan.
  const [pos, setts] = await Promise.all([
    prisma.tbkTesoreria.findUnique({ where: { id: tbkTesoreriaId }, select: { id: true } }),
    prisma.transbankSale.findMany({ where: { id: { in: settIds } }, select: { id: true } }),
  ]);
  if (!pos) return NextResponse.json({ error: "Movimiento POS no encontrado" }, { status: 404 });
  if (setts.length !== settIds.length) {
    return NextResponse.json({ error: "Abono Transbank no encontrado" }, { status: 404 });
  }

  try {
    const created = await prisma.$transaction(
      settIds.map((transbankSaleId) =>
        prisma.cruceTransbankLink.create({
          data: { tbkTesoreriaId, transbankSaleId, nota: nota ?? null, createdById: session.sub },
        }),
      ),
    );
    return NextResponse.json({ ok: true, ids: created.map((l) => l.id) }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "Alguno de los abonos ya está vinculado a otro POS. Deshacé ese vínculo primero." },
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

  if (id) {
    const link = await prisma.cruceTransbankLink.findUnique({ where: { id } });
    if (!link) return NextResponse.json({ error: "Vínculo no encontrado" }, { status: 404 });
    await prisma.cruceTransbankLink.delete({ where: { id } });
    return NextResponse.json({ ok: true, deleted: 1 });
  }

  // Por POS: borra el grupo completo (1:N).
  const { count } = await prisma.cruceTransbankLink.deleteMany({
    where: { tbkTesoreriaId: tbkTesoreriaId! },
  });
  if (count === 0) return NextResponse.json({ error: "Vínculo no encontrado" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted: count });
}
