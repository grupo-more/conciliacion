import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getCuadraturaSettings } from "@/lib/cuadratura/settings";
import { getPendingPairs } from "@/lib/cuadratura/pending";
import { buildCuadraturaAsiento, type CuadraturaItemInput } from "@/lib/cuadratura/asiento";
import { denyUnless } from "@/lib/perms";

/**
 * Asiento de cuadratura Transbank (subtab "Conciliados (asiento)").
 *
 * GET ?mode=preview&from&to&sucursalId  → asiento de los cuadrados PENDIENTES
 *       (aún no llevados a una cuadratura). Es lo que se generaría.
 * GET ?mode=generadas&from&to           → cuadraturas ya generadas (historial).
 * GET ?cuadraturaId=X                   → asiento de una cuadratura puntual.
 * POST {from,to,sucursalId?,glosa?}     → genera la cuadratura (marca consumido).
 * DELETE ?id=X                          → deshace una cuadratura (libera pares).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const cuadraturaId = url.searchParams.get("cuadraturaId");
  const mode = url.searchParams.get("mode") || "preview";
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const sucursalIdRaw = url.searchParams.get("sucursalId");
  const sucursalId = sucursalIdRaw ? parseInt(sucursalIdRaw, 10) : null;

  const settings = await getCuadraturaSettings();
  // Rubros para el asiento de consolidación. El match POS→rubro es por NOMBRE
  // contra la pestaña Rubros (ej. rubro 202 llamado "El Bosque"), NO por el
  // maestro de Sucursales (ese módulo es solo para Asientos manuales). El mapa
  // final POS sucursalId → rubro se arma por path con sus items (mapRubroPorSucursal).
  const sucursalRubros = await loadSucursalRubros();

  // Asiento de una cuadratura ya generada (desde sus items persistidos).
  if (cuadraturaId) {
    const cuad = await prisma.cuadraturaTransbank.findUnique({
      where: { id: cuadraturaId },
      include: { items: true },
    });
    if (!cuad) return NextResponse.json({ error: "Cuadratura no encontrada" }, { status: 404 });
    const items: CuadraturaItemInput[] = cuad.items.map((i) => ({
      sucursalId: i.sucursalId,
      sucursalName: i.sucursalName,
      sucursalCodigo: i.sucursalCodigo,
      montoDynatech: i.montoDynatech,
      montoTransbank: i.montoTransbank,
      montoComision: i.montoComision,
      montoComisionApi: i.montoComisionApi,
      tbkTesoreriaId: i.tbkTesoreriaId,
      transbankSaleId: i.transbankSaleId,
      fecha: i.fecha ? i.fecha.toISOString() : null,
      opBoleta: i.opBoleta,
      medioPago: i.medioPago,
    }));
    const rubroPorSucursal = mapRubroPorSucursal(items, sucursalRubros);
    return NextResponse.json({
      cuadratura: serializeCuadratura(cuad, cuad.items.length),
      asiento: buildCuadraturaAsiento(
        items,
        {
          rubroVentas: cuad.rubroVentas,
          rubroTesoreria: cuad.rubroTesoreria,
          rubroComision: cuad.rubroComision,
          rubroDiferencia: cuad.rubroDiferencia,
        },
        rubroPorSucursal,
      ),
    });
  }

  // Historial de cuadraturas en el rango (por fecha de creación).
  if (mode === "generadas") {
    const cuads = await prisma.cuadraturaTransbank.findMany({
      where: { desde: { lt: to }, hasta: { gt: from } },
      include: { _count: { select: { items: true } } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return NextResponse.json({
      from: from.toISOString(),
      to: to.toISOString(),
      cuadraturas: cuads.map((c) => serializeCuadratura(c, c._count.items)),
    });
  }

  // mode = preview: lo pendiente por cuadrar en el rango.
  const pending = await getPendingPairs(from, to, { sucursalId });
  const items: CuadraturaItemInput[] = pending.map((p) => ({
    sucursalId: p.sucursalId,
    sucursalName: p.sucursalName,
    sucursalCodigo: p.sucursalCodigo,
    montoDynatech: p.montoDynatech,
    montoTransbank: p.montoTransbank,
    montoComision: p.montoComision,
    montoComisionApi: p.montoComisionApi,
    tbkTesoreriaId: p.tbkTesoreriaId,
    transbankSaleId: p.transbankSaleId,
    fecha: p.fecha,
    opBoleta: p.opBoleta,
    medioPago: p.medioPago,
  }));
  const rubroPorSucursal = mapRubroPorSucursal(items, sucursalRubros);

  // Facets de sucursal: las presentes en los pendientes del rango (sin filtro).
  const allPending = sucursalId == null ? pending : await getPendingPairs(from, to);
  const sucMap = new Map<number, string | null>();
  for (const p of allPending) if (!sucMap.has(p.sucursalId)) sucMap.set(p.sucursalId, p.sucursalName);

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    settings,
    pendingCount: pending.length,
    asiento: buildCuadraturaAsiento(items, settings, rubroPorSucursal),
    facets: {
      sucursales: [...sucMap.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.id - b.id),
    },
  });
}

const postSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sucursalId: z.number().int().nullable().optional(),
  glosa: z.string().trim().max(500).nullable().optional(),
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
  const sucursalId = parsed.data.sucursalId ?? null;

  const settings = await getCuadraturaSettings();
  const pending = await getPendingPairs(from, to, { sucursalId });
  if (pending.length === 0) {
    return NextResponse.json({ error: "No hay movimientos pendientes por cuadrar en el rango." }, { status: 400 });
  }

  // Totales snapshot. 708 = Σ recargo; 1403 "Diferencia" = Σ c708 − recargo;
  // 1403 "a favor" = Σ c708 − cartola.
  let totDynatech = 0n;
  let totTransbank = 0n;
  let totC708 = 0n;
  let totRecargo = 0n;
  for (const p of pending) {
    const c708 = p.montoComisionApi > 0n ? p.montoComisionApi : p.montoComision;
    const transbankBruto = p.montoTransbank + p.montoComision;
    totDynatech += p.montoDynatech;
    totTransbank += p.montoTransbank;
    totC708 += c708;
    totRecargo += transbankBruto - p.montoDynatech;
  }
  const totComisionCartola = totRecargo; // → 708
  const totDiferencia = totC708 - totRecargo; // → 1403 "Diferencia"

  try {
    const created = await prisma.$transaction(async (tx) => {
      const cuad = await tx.cuadraturaTransbank.create({
        data: {
          desde: from,
          hasta: to,
          glosa: parsed.data.glosa ?? null,
          rubroVentas: settings.rubroVentas,
          rubroTesoreria: settings.rubroTesoreria,
          rubroComision: settings.rubroComision,
          rubroDiferencia: settings.rubroDiferencia,
          totalDynatech: totDynatech,
          totalTransbank: totTransbank,
          totalComision: totComisionCartola,
          totalDiferencia: totDiferencia,
          createdById: session.sub,
        },
      });
      await tx.cuadraturaTransbankItem.createMany({
        data: pending.map((p) => ({
          cuadraturaId: cuad.id,
          tbkTesoreriaId: p.tbkTesoreriaId,
          transbankSaleId: p.transbankSaleId,
          sucursalId: p.sucursalId,
          sucursalName: p.sucursalName,
          sucursalCodigo: p.sucursalCodigo,
          fecha: p.fechaPos,
          opBoleta: p.opBoleta,
          medioPago: p.medioPago,
          montoDynatech: p.montoDynatech,
          montoTransbank: p.montoTransbank,
          montoComision: p.montoComision,
          montoComisionApi: p.montoComisionApi,
        })),
      });
      return cuad;
    });
    return NextResponse.json({ ok: true, cuadraturaId: created.id, itemCount: pending.length }, { status: 201 });
  } catch (e) {
    // Conflicto de unicidad: otro proceso consumió un par en paralelo.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "Algunos movimientos ya fueron cuadrados. Recargá y volvé a intentar." },
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

  const exists = await prisma.cuadraturaTransbank.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return NextResponse.json({ error: "Cuadratura no encontrada" }, { status: 404 });

  // Borra la cuadratura; los items caen por cascada y los pares quedan libres.
  await prisma.cuadraturaTransbank.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

/**
 * Rubros contables candidatos para el asiento de consolidación: TODOS los de la
 * pestaña Rubros (código + nombre). El match a la sucursal del POS es por nombre
 * (mapRubroPorSucursal), sin pasar por el maestro de Sucursales.
 */
async function loadSucursalRubros(): Promise<{ rubro: number; name: string }[]> {
  return prisma.rubroLabel.findMany({ select: { rubro: true, name: true } });
}

/** Normaliza un nombre para comparar: minúsculas, sin acentos/ñ, espacios simples. */
function normNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mapa POS sucursalId → rubro contable, resuelto por NOMBRE contra la pestaña
 * Rubros (ej. el POS manda sucursalId 2 / "BOSQUE" → rubro 202 "El Bosque").
 * Cruce Transbank NO usa el maestro de Sucursales (ese es solo para Asientos
 * manuales). Cada sucursal del POS matchea el rubro cuyo nombre coincide (exacto
 * normalizado; si no, contención única). Sin match → no entra al mapa y el
 * asiento cae al número POS (comportamiento previo, visible como "sin rubro").
 */
function mapRubroPorSucursal(
  items: { sucursalId: number; sucursalName: string | null }[],
  rubros: { rubro: number; name: string }[],
): Map<number, number> {
  const byNorm = rubros.map((r) => ({ rubro: r.rubro, norm: normNombre(r.name) }));
  const map = new Map<number, number>();
  for (const it of items) {
    if (map.has(it.sucursalId)) continue;
    const posName = normNombre(it.sucursalName ?? "");
    if (!posName) continue;
    let hit = byNorm.find((r) => r.norm === posName);
    if (!hit) {
      const cands = byNorm.filter(
        (r) => r.norm && (r.norm.includes(posName) || posName.includes(r.norm)),
      );
      if (cands.length === 1) hit = cands[0];
    }
    if (hit) map.set(it.sucursalId, hit.rubro);
  }
  return map;
}

function serializeCuadratura(
  c: {
    id: string;
    desde: Date;
    hasta: Date;
    glosa: string | null;
    createdAt: Date;
    totalDynatech: bigint;
    totalTransbank: bigint;
    totalComision: bigint;
    totalDiferencia: bigint;
  },
  itemCount: number,
) {
  return {
    id: c.id,
    desde: c.desde.toISOString(),
    hasta: c.hasta.toISOString(),
    glosa: c.glosa,
    createdAt: c.createdAt.toISOString(),
    itemCount,
    totalDynatech: c.totalDynatech.toString(),
    totalTransbank: c.totalTransbank.toString(),
    totalComision: c.totalComision.toString(),
    totalDiferencia: c.totalDiferencia.toString(),
  };
}

function parseRange(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  const parse = (s: string | null) => {
    const m = s?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0) : null;
  };
  const from = parse(fromRaw);
  const to = parse(toRaw);
  if (from && to) {
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 1);
    return { from, to: toEnd };
  }
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  };
}
