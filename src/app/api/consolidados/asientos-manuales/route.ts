import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseRange } from "@/lib/reportes/classify";
import { computeBancoSinConciliar } from "@/lib/reportes/banco-compute";
import { getAsientoSettings } from "@/lib/asientos/settings";
import { prorratear, calcRetencion } from "@/lib/asientos/prorrateo";
import { loadEntidadesInternas } from "@/lib/internos/detect";
import { buildRubroMap, type AccountForRubro } from "@/lib/internos/rubro-resolver";
import { denyUnless } from "@/lib/perms";

/**
 * Módulo "Asientos manuales": movimientos de cartola sin contraparte en el
 * sistema, resueltos a mano generando un asiento contable.
 *
 * GET  ?mode=pendientes&from&to&accountId  → brecha de banco sin asiento (reusa
 *        el cómputo de "banco sin conciliar"; los que ya tienen asiento salen).
 * GET  ?mode=generados&from&to&accountId   → asientos ya generados con sus líneas.
 * POST                                     → genera el asiento (proveedor).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "pendientes";
  const { from, to } = parseRange(url.searchParams.get("from"), url.searchParams.get("to"));
  const accountId = url.searchParams.get("accountId") || null;

  if (mode === "generados") {
    const asientos = await prisma.asientoManual.findMany({
      where: {
        estado: "GENERADO",
        bankMovement: {
          postDate: { gte: from, lt: to },
          ...(accountId ? { accountId } : {}),
        },
      },
      include: {
        bankMovement: { include: { account: true } },
        lineas: { orderBy: { monto: "desc" }, include: { sucursal: { select: { codigo: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 5000,
    });

    // Rubro del banco (HABER del neto) resuelto con la misma cascada que usa
    // Traspasos internos: nombre de cuenta ↔ RubroLabel, o rubro de la entidad.
    const [rubros, entidades] = await Promise.all([
      prisma.rubroLabel.findMany({
        where: { isDifference: false },
        select: { rubro: true, name: true, accountId: true, sucursalId: true },
      }),
      loadEntidadesInternas(prisma),
    ]);
    // Mapa Sucursal.id → rubro contable (enlace explícito en Configuración → Rubros).
    const sucursalRubroMap = new Map<string, number>();
    for (const r of rubros) if (r.sucursalId) sucursalRubroMap.set(r.sucursalId, r.rubro);
    const accountsForRubro: AccountForRubro[] = [];
    const seenAcc = new Set<string>();
    for (const a of asientos) {
      const acc = a.bankMovement.account;
      if (!seenAcc.has(acc.id)) {
        seenAcc.add(acc.id);
        accountsForRubro.push({ id: acc.id, bankName: acc.bankName, holderName: acc.holderName, holderRut: acc.holderRut });
      }
    }
    const rubroMap = buildRubroMap(
      accountsForRubro,
      rubros,
      entidades.map((e) => ({ rutCanonico: e.rutCanonico, rubro: e.rubro })),
    );

    return NextResponse.json({
      from: from.toISOString(),
      to: to.toISOString(),
      asientos: asientos.map((a) => ({
        id: a.id,
        bankMovementId: a.bankMovementId,
        tipo: a.tipo,
        fecha: a.bankMovement.postDate.toISOString(),
        bankName: a.bankMovement.account.bankName,
        holderName: a.bankMovement.account.holderName,
        accountNumber: a.bankMovement.account.displayNumber || a.bankMovement.account.accountNumber,
        // Rubro contable del banco (HABER del neto), o null si no se pudo resolver.
        bancoRubro: rubroMap.get(a.bankMovement.account.id) ?? null,
        counterpartyName: a.bankMovement.counterpartyName,
        glosa: a.glosa,
        montoNeto: a.montoNeto.toString(),
        retencionTasa: a.retencionTasa != null ? Number(a.retencionTasa) : null,
        montoRetencion: a.montoRetencion.toString(),
        retencionRubro: a.retencionRubro,
        montoBruto: a.montoBruto.toString(),
        lineas: a.lineas.map((l) => ({
          sucursalNombre: l.sucursalNombre,
          // Rubro contable de la sucursal: enlace explícito (Rubros → Sucursal);
          // si no está enlazada, cae al código POS de la sucursal.
          rubro: sucursalRubroMap.get(l.sucursalId) ?? l.sucursal.codigo,
          personas: Number(l.personas),
          porcentaje: Number(l.porcentaje),
          monto: l.monto.toString(),
        })),
      })),
    });
  }

  // mode = pendientes: la brecha de banco (sin asiento, ya excluido en compute).
  const result = await computeBancoSinConciliar(from, to, { accountId });
  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows: result.rows,
    totals: { count: result.resumen.count, monto: result.resumen.monto },
    facets: result.facets,
  });
}

const lineaSchema = z.object({
  sucursalId: z.string().uuid(),
  personas: z.number().min(0).max(10000),
});

const postSchema = z.object({
  bankMovementId: z.string().uuid(),
  // PROVEEDOR: prorrateo por sucursal (+retención opcional). CLIENTE: una sola
  // sucursal, sin impuestos (banco ↔ sucursal, 1:1).
  tipo: z.enum(["PROVEEDOR", "CLIENTE"]),
  glosa: z.string().trim().max(500).optional().nullable(),
  notas: z.string().trim().max(500).optional().nullable(),
  // Retención opcional: por % (se calcula) o monto directo. Si ambos, gana monto.
  // Solo aplica a PROVEEDOR.
  retencion: z
    .object({
      tasa: z.number().min(0).max(100).optional(),
      monto: z.number().int().min(0).optional(),
    })
    .nullable()
    .optional(),
  // PROVEEDOR: 1..N sucursales (prorrateo). CLIENTE: exactamente 1.
  sucursales: z.array(lineaSchema).min(1).max(100),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "generarAsientos");
  if (deniedPerm) return deniedPerm;

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { bankMovementId, tipo, glosa, notas, retencion, sucursales } = parsed.data;

  if (tipo === "CLIENTE" && sucursales.length !== 1) {
    return NextResponse.json(
      { error: "Un asiento de cliente debe apuntar a exactamente una sucursal." },
      { status: 400 },
    );
  }

  const bm = await prisma.bankMovement.findUnique({
    where: { id: bankMovementId },
    include: { asientoManual: { select: { id: true } } },
  });
  if (!bm) return NextResponse.json({ error: "Movimiento no encontrado" }, { status: 404 });
  if (bm.asientoManual) {
    return NextResponse.json(
      { error: "Este movimiento ya tiene un asiento. Deshacelo primero." },
      { status: 409 },
    );
  }

  const montoNeto = bm.amount < 0n ? -bm.amount : bm.amount;

  // Cargar las sucursales elegidas (validar que existen).
  const ids = sucursales.map((s) => s.sucursalId);
  const sucRows = await prisma.sucursal.findMany({ where: { id: { in: ids } } });
  const sucById = new Map(sucRows.map((s) => [s.id, s]));
  if (sucRows.length !== new Set(ids).size) {
    return NextResponse.json({ error: "Una o más sucursales no existen" }, { status: 400 });
  }

  // Retención + prorrateo: SOLO proveedor. Cliente va limpio, 1 sucursal.
  let montoRetencion = 0n;
  let retencionTasa: number | null = null;
  let retencionRubro: number | null = null;
  let lineas: Array<{ id: string; nombre: string; personas: number; porcentaje: number; monto: bigint }>;

  if (tipo === "PROVEEDOR") {
    const settings = await getAsientoSettings();
    if (retencion) {
      if (retencion.monto != null && retencion.monto > 0) {
        montoRetencion = BigInt(retencion.monto);
      } else if (retencion.tasa != null && retencion.tasa > 0) {
        retencionTasa = retencion.tasa;
        montoRetencion = calcRetencion(montoNeto, retencion.tasa).montoRetencion;
      }
    }
    retencionRubro = montoRetencion > 0n ? settings.retencionRubro : null;
    const montoBrutoProv = montoNeto + montoRetencion;
    lineas = prorratear(
      montoBrutoProv,
      sucursales.map((s) => ({
        id: s.sucursalId,
        nombre: sucById.get(s.sucursalId)!.nombre,
        personas: s.personas,
      })),
    );
  } else {
    // CLIENTE: una sola línea con el monto completo (banco ↔ sucursal, 1:1).
    const s = sucursales[0];
    lineas = [
      {
        id: s.sucursalId,
        nombre: sucById.get(s.sucursalId)!.nombre,
        personas: 0,
        porcentaje: 100,
        monto: montoNeto,
      },
    ];
  }
  const montoBruto = montoNeto + montoRetencion;

  const created = await prisma.$transaction(async (tx) => {
    const asiento = await tx.asientoManual.create({
      data: {
        bankMovementId,
        tipo,
        estado: "GENERADO",
        montoNeto,
        retencionTasa: retencionTasa != null ? new Prisma.Decimal(retencionTasa) : null,
        montoRetencion,
        retencionRubro,
        montoBruto,
        glosa: glosa ?? bm.description,
        notas: notas ?? null,
        createdById: session.sub,
      },
    });
    await tx.asientoManualLinea.createMany({
      data: lineas.map((l) => ({
        asientoId: asiento.id,
        sucursalId: l.id,
        sucursalNombre: l.nombre,
        personas: new Prisma.Decimal(l.personas),
        porcentaje: new Prisma.Decimal(l.porcentaje),
        monto: l.monto,
      })),
    });
    return asiento;
  });

  return NextResponse.json({ ok: true, asientoId: created.id }, { status: 201 });
}
