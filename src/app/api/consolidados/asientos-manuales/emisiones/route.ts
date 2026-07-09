import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseRange } from "@/lib/reportes/classify";
import { loadAsientosSerializados } from "@/lib/asientos/serialize";
import { denyUnless } from "@/lib/perms";

/**
 * Emisiones de asientos manuales (lote documental). Mismo patrón que las
 * cuadraturas de Transbank: emitir agrupa los asientos GENERADOS del filtro en
 * un conjunto con folio, los saca de "Generados" y el documento queda
 * re-generable EXACTO desde la emisión (auditoría / re-descarga).
 *
 * GET               → lista de emisiones (folio, rango, totales).
 * GET  ?id=<uuid>   → detalle: los asientos de esa emisión (para preview/export).
 * POST {from,to,accountId?} → emite: asientos GENERADOS del filtro → EMITIDO.
 * DELETE ?id=<uuid> → deshace la emisión (asientos vuelven a GENERADO).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const emision = await prisma.emisionAsientos.findUnique({ where: { id } });
    if (!emision) return NextResponse.json({ error: "Emisión no encontrada" }, { status: 404 });
    const asientos = await loadAsientosSerializados({ emisionId: id });
    return NextResponse.json({
      emision: serializeEmision(emision),
      asientos,
    });
  }

  const emisiones = await prisma.emisionAsientos.findMany({
    orderBy: { folio: "desc" },
    take: 500,
  });
  return NextResponse.json({ emisiones: emisiones.map(serializeEmision) });
}

const postSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "generarAsientos");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { from, to } = parseRange(parsed.data.from, parsed.data.to);
  const accountId = parsed.data.accountId ?? null;

  // Los mismos asientos que muestra la vista "Generados" con ese filtro.
  const asientos = await prisma.asientoManual.findMany({
    where: {
      estado: "GENERADO",
      bankMovement: {
        postDate: { gte: from, lt: to },
        ...(accountId ? { accountId } : {}),
      },
    },
    select: { id: true, montoNeto: true, montoBruto: true },
  });
  if (asientos.length === 0) {
    return NextResponse.json({ error: "No hay asientos generados en el filtro para emitir." }, { status: 400 });
  }

  const totalNeto = asientos.reduce((acc, a) => acc + a.montoNeto, 0n);
  const totalBruto = asientos.reduce((acc, a) => acc + a.montoBruto, 0n);

  const emision = await prisma.$transaction(async (tx) => {
    const e = await tx.emisionAsientos.create({
      data: {
        desde: from,
        hasta: to,
        count: asientos.length,
        totalNeto,
        totalBruto,
        createdById: session.sub,
      },
    });
    await tx.asientoManual.updateMany({
      where: { id: { in: asientos.map((a) => a.id) } },
      data: { estado: "EMITIDO", emisionId: e.id },
    });
    return e;
  });

  return NextResponse.json(
    { ok: true, id: emision.id, folio: emision.folio, count: asientos.length },
    { status: 201 },
  );
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "generarAsientos");
  if (deniedPerm) return deniedPerm;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });

  const emision = await prisma.emisionAsientos.findUnique({ where: { id } });
  if (!emision) return NextResponse.json({ error: "Emisión no encontrada" }, { status: 404 });

  await prisma.$transaction([
    prisma.asientoManual.updateMany({
      where: { emisionId: id },
      data: { estado: "GENERADO", emisionId: null },
    }),
    prisma.emisionAsientos.delete({ where: { id } }),
  ]);
  return NextResponse.json({ ok: true, folio: emision.folio });
}

function serializeEmision(e: {
  id: string;
  folio: number;
  desde: Date;
  hasta: Date;
  count: number;
  totalNeto: bigint;
  totalBruto: bigint;
  createdAt: Date;
}) {
  return {
    id: e.id,
    folio: e.folio,
    desde: e.desde.toISOString(),
    hasta: e.hasta.toISOString(),
    count: e.count,
    totalNeto: e.totalNeto.toString(),
    totalBruto: e.totalBruto.toString(),
    createdAt: e.createdAt.toISOString(),
  };
}
