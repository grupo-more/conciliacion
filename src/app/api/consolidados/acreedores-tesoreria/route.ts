import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

/**
 * Cola manual "Acreedores tesorería".
 *
 * Ciertas tesorerías EGRESO corresponden a acreedores y no hay ningún dato del
 * feed que permita identificarlas automáticamente: el operador las reconoce a
 * ojo en Comparar Egresos y las deriva acá. La tab "Acreedores tesorería"
 * (Consolidados) las muestra para cuadrarlas a mano contra cartola — sus
 * depósitos llegan con días de desfase, así que la fecha no sirve de criterio.
 *
 * POST   → deriva una o varias tesorerías EGRESO a la cola. Bloquea las que ya
 *          tienen conciliación real (AUTO_MATCHED / MANUAL): deshacer primero.
 * DELETE → devuelve una o varias a Comparar Egresos (deshace la derivación).
 *
 * Marcar NO resuelve: la tesorería sigue pendiente en Reportes hasta que se
 * vincule vía manual-link desde la tab. Mientras esté marcada queda fuera de
 * Comparar Egresos y de los motores automáticos (motor V3 y egresos a
 * terceros), para que nada la toque salvo el cuadre manual.
 */

const bodySchema = z.object({
  tesoreriaIds: z.array(z.string().uuid()).min(1).max(500),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "conciliar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { tesoreriaIds } = parsed.data;

  const movs = await prisma.tesoreriaMovement.findMany({
    where: { id: { in: tesoreriaIds } },
    select: {
      id: true,
      fecha: true,
      glosa: true,
      tipoOperacion: true,
      acreedorTesoreriaAt: true,
      consolidado: { select: { status: true } },
    },
  });

  // Motivos que bloquean la derivación.
  const motivoDe = (m: (typeof movs)[number]): string | null => {
    if (m.tipoOperacion !== "EGRESO") return "no es un egreso (solo EGRESO se deriva a Acreedores)";
    const st = m.consolidado?.status;
    if (st === "AUTO_MATCHED" || st === "MANUAL")
      return "ya está conciliado (deshacé el vínculo primero)";
    return null;
  };
  const bloqueados = movs
    .map((m) => ({ m, motivo: motivoDe(m) }))
    .filter((x): x is { m: (typeof movs)[number]; motivo: string } => x.motivo !== null);
  const bloqueadoIds = new Set(bloqueados.map((x) => x.m.id));
  const aMarcar = movs.filter((m) => !bloqueadoIds.has(m.id) && !m.acreedorTesoreriaAt);

  if (aMarcar.length > 0) {
    await prisma.tesoreriaMovement.updateMany({
      where: { id: { in: aMarcar.map((m) => m.id) } },
      data: { acreedorTesoreriaAt: new Date(), acreedorTesoreriaById: session.sub },
    });
  }

  const detalleBloqueados = bloqueados.map((x) => ({
    id: x.m.id,
    fecha: x.m.fecha.toISOString().slice(0, 10),
    glosa: x.m.glosa,
    motivo: x.motivo,
  }));

  let mensaje: string;
  if (bloqueados.length === 0) {
    mensaje = `${aMarcar.length} movimiento(s) derivado(s) a Acreedores tesorería.`;
  } else {
    const lineas = detalleBloqueados
      .map((d) => `• ${d.fecha} · ${d.glosa} → ${d.motivo}`)
      .join("\n");
    mensaje = `${aMarcar.length} derivado(s). ${bloqueados.length} bloqueado(s):\n${lineas}`;
  }

  return NextResponse.json({
    derivados: aMarcar.length,
    bloqueados: detalleBloqueados,
    yaDerivados: movs.filter((m) => m.acreedorTesoreriaAt).map((m) => m.id),
    mensaje,
  });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "conciliar");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", detail: parsed.error.issues }, { status: 400 });
  }
  const { tesoreriaIds } = parsed.data;

  const result = await prisma.tesoreriaMovement.updateMany({
    where: { id: { in: tesoreriaIds }, acreedorTesoreriaAt: { not: null } },
    data: { acreedorTesoreriaAt: null, acreedorTesoreriaById: null },
  });

  return NextResponse.json({
    devueltos: result.count,
    mensaje: `${result.count} movimiento(s) devuelto(s) a Comparar Egresos.`,
  });
}
