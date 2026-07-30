import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Emisiones GENÉRICAS para las tabs de asiento derivadas (calculadas al vuelo):
 * OK, Abono Transbank, Dif menor y Traspasos internos.
 *
 * A diferencia de Asientos manuales/Proveedores (entidades persistidas con
 * estado), acá el documento se CONGELA en un snapshot al emitir — las líneas
 * exactas que el usuario estaba viendo/descargando — y los movimientos
 * involucrados quedan consumidos (EmisionConsumo), lo que los saca del listado
 * de esa tab. Los motores de matching y Reportes NO miran el consumo: emitir
 * jamás des-resuelve nada.
 *
 * GET  ?origen=X        → lista de emisiones de esa tab.
 * GET  ?id=<uuid>       → detalle con snapshot (para Ver / Re-descargar).
 * POST                  → emite: valida cuadre + refs libres, congela snapshot.
 * DELETE ?id=<uuid>     → deshace: libera los consumos (las filas reaparecen).
 */

const ORIGENES_DERIVADOS = [
  "OK",
  "ABONO_TRANSBANK",
  "DIF_MENOR",
  "DIF_MENOR_EGRESO",
  "COMISION",
  "TRASPASOS_INTERNOS",
  "EGRESOS_TERCEROS",
  "ABONO_CONCILIADO",
] as const;
type OrigenDerivado = (typeof ORIGENES_DERIVADOS)[number];

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const emision = await prisma.emisionAsientos.findUnique({ where: { id } });
    if (!emision) return NextResponse.json({ error: "Emisión no encontrada" }, { status: 404 });
    return NextResponse.json({ emision: serialize(emision, true) });
  }

  const origen = url.searchParams.get("origen") as OrigenDerivado | null;
  if (!origen || !ORIGENES_DERIVADOS.includes(origen)) {
    return NextResponse.json({ error: "Falta origen válido" }, { status: 400 });
  }
  const emisiones = await prisma.emisionAsientos.findMany({
    where: { origen },
    orderBy: { folio: "desc" },
    take: 500,
  });
  return NextResponse.json({ emisiones: emisiones.map((e) => serialize(e, false)) });
}

const lineaSchema = z.object({
  rubro: z.union([z.number(), z.string()]),
  detalle: z.string().max(500),
  cliente: z.union([z.number(), z.string()]).optional(),
  debe: z.union([z.number(), z.string()]).nullable().optional(),
  haber: z.union([z.number(), z.string()]).nullable().optional(),
});

const postSchema = z.object({
  origen: z.enum(ORIGENES_DERIVADOS),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fechaDoc: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(120),
  lineas: z.array(lineaSchema).min(1).max(20000),
  // bankMovementIds o consolidadoIds según la tab; quedan consumidos.
  refIds: z.array(z.string().uuid()).min(1).max(10000),
});

const toBig = (v: number | string | null | undefined): bigint => {
  if (v == null || v === "") return 0n;
  return typeof v === "number" ? BigInt(Math.round(v)) : BigInt(v);
};

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
  const d = parsed.data;
  const refIds = Array.from(new Set(d.refIds));

  // 1) El documento tiene que cuadrar (Debe = Haber) — misma garantía que la vista.
  let totalDebe = 0n;
  let totalHaber = 0n;
  for (const l of d.lineas) {
    totalDebe += toBig(l.debe);
    totalHaber += toBig(l.haber);
  }
  if (totalDebe !== totalHaber) {
    return NextResponse.json(
      { error: `El asiento no cuadra: Debe $${totalDebe} ≠ Haber $${totalHaber}. No se emitió.` },
      { status: 400 },
    );
  }

  // 2) Ningún ref puede estar ya consumido por otra emisión (de cualquier tab).
  const yaConsumidos = await prisma.emisionConsumo.findMany({
    where: { refId: { in: refIds } },
    select: { refId: true, emision: { select: { folio: true, origen: true } } },
  });
  if (yaConsumidos.length > 0) {
    const det = yaConsumidos
      .slice(0, 3)
      .map((c) => `#${c.emision.folio} (${c.emision.origen})`)
      .join(", ");
    return NextResponse.json(
      {
        error:
          `${yaConsumidos.length} movimiento(s) ya pertenecen a otra emisión (${det}). ` +
          `Refrescá la vista e intentá de nuevo.`,
      },
      { status: 409 },
    );
  }

  const { from, to } = rangeFromStrings(d.from, d.to);
  try {
    const emision = await prisma.$transaction(async (tx) => {
      const e = await tx.emisionAsientos.create({
        data: {
          origen: d.origen,
          desde: from,
          hasta: to,
          count: refIds.length,
          totalNeto: totalDebe,
          totalBruto: totalHaber,
          snapshot: {
            lineas: d.lineas,
            fechaDoc: d.fechaDoc,
            descripcion: d.descripcion,
            filename: d.filename,
          } as object,
          createdById: session.sub,
        },
      });
      await tx.emisionConsumo.createMany({
        data: refIds.map((refId) => ({ emisionId: e.id, refId })),
      });
      return e;
    });
    return NextResponse.json({ ok: true, id: emision.id, folio: emision.folio }, { status: 201 });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Carrera: otro emitió entre el chequeo y el insert.
      return NextResponse.json(
        { error: "Alguno de los movimientos acaba de ser emitido en otra sesión. Refrescá la vista." },
        { status: 409 },
      );
    }
    throw e;
  }
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
  if (!ORIGENES_DERIVADOS.includes(emision.origen as OrigenDerivado)) {
    return NextResponse.json(
      { error: "Esta emisión es de Asientos manuales/Proveedores: deshacela desde su propia tab." },
      { status: 400 },
    );
  }

  // Los consumos caen por cascade → las filas reaparecen en la vista.
  await prisma.emisionAsientos.delete({ where: { id } });
  return NextResponse.json({ ok: true, folio: emision.folio });
}

function serialize(
  e: {
    id: string;
    folio: number;
    origen: string;
    desde: Date;
    hasta: Date;
    count: number;
    totalNeto: bigint;
    totalBruto: bigint;
    snapshot: unknown;
    createdAt: Date;
  },
  withSnapshot: boolean,
) {
  return {
    id: e.id,
    folio: e.folio,
    origen: e.origen,
    desde: e.desde.toISOString(),
    hasta: e.hasta.toISOString(),
    count: e.count,
    totalDebe: e.totalNeto.toString(),
    totalHaber: e.totalBruto.toString(),
    createdAt: e.createdAt.toISOString(),
    ...(withSnapshot ? { snapshot: e.snapshot } : {}),
  };
}

// `hasta` se guarda como fin-EXCLUSIVO (día siguiente al "Hasta" elegido),
// igual que el resto de los rangos de la app. Es metadato de despliegue (los
// movimientos se eligen por refIds); al MOSTRARLO se resta 1 día
// (formatDateRangeEnd) para ver el último día realmente incluido.
function rangeFromStrings(fromRaw: string, toRaw: string): { from: Date; to: Date } {
  const [fy, fm, fd] = fromRaw.split("-").map(Number);
  const [ty, tm, td] = toRaw.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  const to = new Date(ty, tm - 1, td, 0, 0, 0, 0);
  to.setDate(to.getDate() + 1);
  return { from, to };
}
