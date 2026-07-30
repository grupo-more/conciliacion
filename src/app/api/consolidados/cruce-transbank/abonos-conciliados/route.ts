import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";
import { getAbonoConciliadoSettings } from "@/lib/transbank/abono-conciliado";
import { consumedRefIds } from "@/lib/consolidados/emision-consumo";

/**
 * "Abonos conciliados" (Cruce Transbank): abonos/cargos del settlement de
 * Transbank que no corresponden a operaciones de la empresa — nunca tendrán
 * POS que los respalde, así que no se cuadran: se identifican a mano en Movimientos y se
 * contabilizan directo contra 2 rubros configurables, por el NETO (totalAbono):
 *
 *   Debe rubroDebe (default 200) / Haber rubroHaber (default 1403)
 *
 * El monto va TAL CUAL: un cargo (neto negativo) queda negativo en el asiento,
 * no se invierte el lado. La resolución es vía emisión (folio), igual que Dif
 * menor: los emitidos salen del listado "Por emitir".
 *
 * GET    ?from&to&sucursalId → asiento de los marcados sin emitir en el rango.
 * POST   { transbankSaleIds } → marca (deriva a la subtab). Bloquea los que
 *        tienen vínculo manual POS↔settlement (desvincular primero).
 * DELETE { transbankSaleIds } → devuelve a Movimientos. Bloquea los emitidos
 *        (deshacer la emisión primero).
 */

const bodySchema = z.object({
  transbankSaleIds: z.array(z.string().uuid()).min(1).max(1000),
});

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const sucursalIdRaw = url.searchParams.get("sucursalId");
  const sucursalId = sucursalIdRaw ? parseInt(sucursalIdRaw, 10) : null;

  const settings = await getAbonoConciliadoSettings();
  const emitidos = await consumedRefIds("ABONO_CONCILIADO");

  const sales = await prisma.transbankSale.findMany({
    where: {
      abonoConciliadoAt: { not: null },
      fechaVenta: { gte: from, lt: to },
      ...(sucursalId !== null && !Number.isNaN(sucursalId) ? { sucursalId } : {}),
      ...(emitidos.size > 0 ? { id: { notIn: Array.from(emitidos) } } : {}),
    },
    orderBy: [{ fechaVenta: "desc" }, { createdAt: "desc" }],
    take: 5000,
  });

  // Etiquetas de los 2 rubros del asiento.
  const rubroLabels = await prisma.rubroLabel.findMany({
    where: { rubro: { in: [settings.rubroDebe, settings.rubroHaber] } },
    select: { rubro: true, name: true },
  });
  const labelByRubro = new Map(rubroLabels.map((r) => [r.rubro, r.name]));

  // Nombres de sucursal (mismo criterio que el cruce: POS + feed Tesorería).
  const sucName = new Map<number, string | null>();
  const [tbkSuc, tesoSuc] = await Promise.all([
    prisma.tbkTesoreria.groupBy({ by: ["sucursalId", "sucursalName"] }),
    prisma.tesoreriaMovement.groupBy({ by: ["sucursalId", "sucursalName"] }),
  ]);
  for (const s of tesoSuc) if (s.sucursalName) sucName.set(s.sucursalId, s.sucursalName);
  for (const s of tbkSuc) if (s.sucursalName) sucName.set(s.sucursalId, s.sucursalName);

  const rows: AbonoConciliadoRow[] = [];
  let totalDebe = 0n;
  let totalHaber = 0n;

  for (const s of sales) {
    const neto = s.totalAbono; // TAL CUAL: cargos quedan negativos.
    const sucursal =
      (s.sucursalId != null ? sucName.get(s.sucursalId) : null) ?? s.nombreLocal;
    const glosa = [
      s.nombreLocal,
      s.numeroBoleta ? `boleta ${s.numeroBoleta}` : null,
      s.medioPago,
    ]
      .filter(Boolean)
      .join(" · ");

    // 1) Lado Debe (rubroDebe)
    rows.push({
      groupId: s.id,
      side: "DEBE",
      fecha: s.fechaVenta.toISOString(),
      rubro: settings.rubroDebe,
      rubroLabel: labelByRubro.get(settings.rubroDebe) ?? null,
      detalle: labelByRubro.get(settings.rubroDebe) ?? `Rubro ${settings.rubroDebe}`,
      sucursal,
      glosa,
      debe: neto.toString(),
      haber: null,
      transbankSaleId: s.id,
      neto: neto.toString(),
    });
    // 2) Lado Haber (rubroHaber)
    rows.push({
      groupId: s.id,
      side: "HABER",
      fecha: s.fechaVenta.toISOString(),
      rubro: settings.rubroHaber,
      rubroLabel: labelByRubro.get(settings.rubroHaber) ?? null,
      detalle: labelByRubro.get(settings.rubroHaber) ?? `Rubro ${settings.rubroHaber}`,
      sucursal,
      glosa,
      debe: null,
      haber: neto.toString(),
      transbankSaleId: s.id,
      neto: neto.toString(),
    });

    totalDebe += neto;
    totalHaber += neto;
  }

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    settings,
    rows,
    totals: { debe: totalDebe.toString(), haber: totalHaber.toString() },
  });
}

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
  const { transbankSaleIds } = parsed.data;

  const [sales, links] = await Promise.all([
    prisma.transbankSale.findMany({
      where: { id: { in: transbankSaleIds } },
      select: { id: true, fechaVenta: true, nombreLocal: true, abonoConciliadoAt: true },
    }),
    prisma.cruceTransbankLink.findMany({
      where: { transbankSaleId: { in: transbankSaleIds } },
      select: { transbankSaleId: true },
    }),
  ]);
  const linked = new Set(links.map((l) => l.transbankSaleId));

  const bloqueados = sales.filter((s) => linked.has(s.id));
  const aMarcar = sales.filter((s) => !linked.has(s.id) && !s.abonoConciliadoAt);

  if (aMarcar.length > 0) {
    await prisma.transbankSale.updateMany({
      where: { id: { in: aMarcar.map((s) => s.id) } },
      data: { abonoConciliadoAt: new Date(), abonoConciliadoById: session.sub },
    });
  }

  let mensaje: string;
  if (bloqueados.length === 0) {
    mensaje = `${aMarcar.length} abono(s) movido(s) a "Abonos conciliados".`;
  } else {
    const lineas = bloqueados
      .map((s) => `• ${s.fechaVenta.toISOString().slice(0, 10)} · ${s.nombreLocal} → tiene vínculo manual con un POS (desvinculá primero)`)
      .join("\n");
    mensaje = `${aMarcar.length} movido(s). ${bloqueados.length} bloqueado(s):\n${lineas}`;
  }

  return NextResponse.json({
    movidos: aMarcar.length,
    bloqueados: bloqueados.map((s) => s.id),
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
  const { transbankSaleIds } = parsed.data;

  // Emitidos: el documento ya salió con este abono adentro → deshacer la
  // emisión primero (en la subtab, toggle Emitidos).
  const consumos = await prisma.emisionConsumo.findMany({
    where: { refId: { in: transbankSaleIds }, emision: { origen: "ABONO_CONCILIADO" } },
    select: { refId: true, emision: { select: { folio: true } } },
  });
  const emitidos = new Set(consumos.map((c) => c.refId));

  const result = await prisma.transbankSale.updateMany({
    where: {
      id: { in: transbankSaleIds.filter((id) => !emitidos.has(id)) },
      abonoConciliadoAt: { not: null },
    },
    data: { abonoConciliadoAt: null, abonoConciliadoById: null },
  });

  const mensaje =
    emitidos.size === 0
      ? `${result.count} abono(s) devuelto(s) a Movimientos.`
      : `${result.count} devuelto(s). ${emitidos.size} bloqueado(s): ya emitidos en documento (deshacé la emisión primero).`;

  return NextResponse.json({ devueltos: result.count, bloqueados: Array.from(emitidos), mensaje });
}

interface AbonoConciliadoRow {
  groupId: string;
  side: "DEBE" | "HABER";
  fecha: string;
  rubro: number;
  rubroLabel: string | null;
  detalle: string;
  sucursal: string | null;
  glosa: string;
  debe: string | null;
  haber: string | null;
  transbankSaleId: string;
  neto: string;
}

function parseRange(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  if (fromRaw && toRaw) {
    const from = parseDateOnly(fromRaw);
    const to = parseDateOnly(toRaw);
    if (from && to) {
      const toEnd = new Date(to);
      toEnd.setDate(toEnd.getDate() + 1);
      return { from, to: toEnd };
    }
  }
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

function parseDateOnly(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}
