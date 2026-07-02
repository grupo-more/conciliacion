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
      prisma.rubroLabel.findMany({ where: { isDifference: false }, select: { rubro: true, name: true, accountId: true } }),
      loadEntidadesInternas(prisma),
    ]);
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
          // El "código de sucursal" ES el rubro de gestión del DEBE (así se define en el modal).
          rubro: l.sucursal.codigo,
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
  tipo: z.literal("PROVEEDOR"), // CLIENTE no genera asiento (se deja pendiente)
  glosa: z.string().trim().max(500).optional().nullable(),
  notas: z.string().trim().max(500).optional().nullable(),
  // Retención opcional: por % (se calcula) o monto directo. Si ambos, gana monto.
  retencion: z
    .object({
      tasa: z.number().min(0).max(100).optional(),
      monto: z.number().int().min(0).optional(),
    })
    .nullable()
    .optional(),
  sucursales: z.array(lineaSchema).min(1).max(100),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const { bankMovementId, glosa, notas, retencion, sucursales } = parsed.data;

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

  // Retención: monto directo o calculado por tasa. montoBruto = neto + retención.
  const settings = await getAsientoSettings();
  let montoRetencion = 0n;
  let retencionTasa: number | null = null;
  if (retencion) {
    if (retencion.monto != null && retencion.monto > 0) {
      montoRetencion = BigInt(retencion.monto);
    } else if (retencion.tasa != null && retencion.tasa > 0) {
      retencionTasa = retencion.tasa;
      montoRetencion = calcRetencion(montoNeto, retencion.tasa).montoRetencion;
    }
  }
  const montoBruto = montoNeto + montoRetencion;
  const retencionRubro = montoRetencion > 0n ? settings.retencionRubro : null;

  // Cargar las sucursales elegidas (validar que existen) y prorratear el bruto.
  const ids = sucursales.map((s) => s.sucursalId);
  const sucRows = await prisma.sucursal.findMany({ where: { id: { in: ids } } });
  const sucById = new Map(sucRows.map((s) => [s.id, s]));
  if (sucRows.length !== new Set(ids).size) {
    return NextResponse.json({ error: "Una o más sucursales no existen" }, { status: 400 });
  }

  const lineas = prorratear(
    montoBruto,
    sucursales.map((s) => ({
      id: s.sucursalId,
      nombre: sucById.get(s.sucursalId)!.nombre,
      personas: s.personas,
    })),
  );

  const created = await prisma.$transaction(async (tx) => {
    const asiento = await tx.asientoManual.create({
      data: {
        bankMovementId,
        tipo: "PROVEEDOR",
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
