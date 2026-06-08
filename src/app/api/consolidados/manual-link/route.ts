import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/consolidados/manual-link
 *
 * Vincula manualmente N TesoreriaMovements con M BankMovements.
 *
 * Casos soportados:
 *   - N=1, M=1: match clásico 1:1.
 *   - N=1, M>1: split clásico (N bancos suman lo de 1 tesorería).
 *   - N>1, M=1: split inverso (1 banco se reparte en N tesorerías).
 *   - N>1, M>1: caso híbrido (raro pero soportado).
 *
 * Sin `adjustment`: sum(bms) debe coincidir exacto con sum(tms).
 * Con `adjustment`: solo permitido en N=1 (un ajuste se contabiliza por
 *   consolidado; con N>1 no hay forma única de distribuirlo).
 *
 * Para N>1 se generan N Consolidados (uno por tesorería) y se reparten los
 * montos de los bancos vía greedy en `ConsolidadoLink.amountAllocated`.
 *
 * Body:
 *   {
 *     // Forma nueva (preferida)
 *     tesoreriaIds?: string[],
 *     // Forma vieja (back-compat)
 *     tesoreriaId?: string,
 *
 *     bankMovementIds: string[],
 *     adjustment?: { rubro: number, note?: string } | null,
 *     overrideRubroBanco?: number | null,
 *     // Set true para confirmar el match aunque el backend haya detectado
 *     // que la diferencia podría ser otra tesorería sin matchear (warning).
 *     acknowledgeSiblingWarning?: boolean
 *   }
 */
const bodySchema = z
  .object({
    tesoreriaIds: z.array(z.string().uuid()).min(1).max(10).optional(),
    tesoreriaId: z.string().uuid().optional(),
    bankMovementIds: z.array(z.string().uuid()).min(1).max(10),
    adjustment: z
      .object({
        rubro: z.number().int(),
        note: z.string().max(500).optional().nullable(),
      })
      .optional()
      .nullable(),
    overrideRubroBanco: z.number().int().optional().nullable(),
    acknowledgeSiblingWarning: z.boolean().optional(),
  })
  .refine((d) => !!d.tesoreriaIds || !!d.tesoreriaId, {
    message: "Falta tesoreriaIds o tesoreriaId",
  });

const SIBLING_WINDOW_DAYS = 7;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", detail: parsed.error.format() },
      { status: 400 }
    );
  }

  const {
    bankMovementIds,
    adjustment,
    overrideRubroBanco,
    acknowledgeSiblingWarning,
  } = parsed.data;
  // Normaliza tesoreriaIds (acepta forma vieja por compatibilidad)
  const tesoreriaIds = parsed.data.tesoreriaIds ??
    (parsed.data.tesoreriaId ? [parsed.data.tesoreriaId] : []);
  // Dedupe defensivo
  const uniqueTesoreriaIds = Array.from(new Set(tesoreriaIds));
  const uniqueBankMovementIds = Array.from(new Set(bankMovementIds));

  if (uniqueTesoreriaIds.length === 0) {
    return NextResponse.json(
      { error: "Falta al menos un movimiento de Tesorería" },
      { status: 400 }
    );
  }

  // Ajuste en multi-tesorería (split inverso): la diferencia se carga al
  // asiento de la tesorería que el greedy deja con el faltante (ver más abajo).

  // === Fetch + validate entities ===
  const tms = await prisma.tesoreriaMovement.findMany({
    where: { id: { in: uniqueTesoreriaIds } },
    include: { consolidado: { include: { links: true } } },
  });
  if (tms.length !== uniqueTesoreriaIds.length) {
    return NextResponse.json(
      { error: "Una o más Tesorerías no existen" },
      { status: 404 }
    );
  }

  const bms = await prisma.bankMovement.findMany({
    where: { id: { in: uniqueBankMovementIds } },
    include: {
      consolidadoLinks: { select: { consolidadoId: true } },
    },
  });
  if (bms.length !== uniqueBankMovementIds.length) {
    return NextResponse.json(
      { error: "Uno o más BankMovements no existen" },
      { status: 404 }
    );
  }

  // Los BankMovements no pueden estar en OTROS consolidados (los que ya
  // pertenecen a las tesorerías que estamos re-vinculando son válidos —
  // los vamos a wipear y recrear).
  const ownConsolidadoIds = new Set(
    tms.map((t) => t.consolidado?.id).filter((x): x is string => !!x)
  );
  for (const bm of bms) {
    for (const link of bm.consolidadoLinks) {
      if (!ownConsolidadoIds.has(link.consolidadoId)) {
        return NextResponse.json(
          {
            error: `El BankMovement ${bm.id.slice(0, 8)} ya está vinculado a otro consolidado. Desvinculá ese primero.`,
          },
          { status: 409 }
        );
      }
    }
  }

  // Mismo direction en todos los BMs (no se puede mezclar IN y OUT en
  // un mismo consolidado, el asiento OK lo asume).
  const directions = new Set(bms.map((bm) => bm.direction));
  if (directions.size > 1) {
    return NextResponse.json(
      {
        error:
          "Los movimientos bancarios seleccionados tienen direcciones distintas (IN/OUT). No se pueden conciliar juntos.",
      },
      { status: 400 }
    );
  }

  // === Sumas y validación de balance ===
  const sumBanks = bms.reduce((acc, bm) => acc + bm.amount, 0n);
  const sumTms = tms.reduce((acc, t) => acc + t.monto, 0n);
  const diff = sumBanks - sumTms;
  const absDiff = diff < 0n ? -diff : diff;

  let adjustmentAmount: bigint | null = null;
  let adjustmentRubro: number | null = null;
  let adjustmentNote: string | null = null;

  if (adjustment) {
    // Solo N=1 acá (chequeado más arriba)
    if (absDiff === 0n) {
      return NextResponse.json(
        {
          error:
            "Se especificó un ajuste pero los montos coinciden. Quitá el ajuste y volvé a intentar.",
        },
        { status: 400 }
      );
    }
    const rubro = await prisma.rubroLabel.findUnique({
      where: { rubro: adjustment.rubro },
    });
    if (!rubro) {
      return NextResponse.json(
        { error: `El rubro ${adjustment.rubro} no existe.` },
        { status: 400 }
      );
    }
    if (!rubro.isDifference) {
      return NextResponse.json(
        {
          error: `El rubro ${adjustment.rubro} (${rubro.name}) no está marcado para usarse en diferencias. Activá la opción en Configuración → Rubros.`,
        },
        { status: 400 }
      );
    }
    adjustmentAmount = absDiff;
    adjustmentRubro = adjustment.rubro;
    adjustmentNote = adjustment.note?.trim() || null;
  } else if (sumBanks !== sumTms) {
    return NextResponse.json(
      {
        error: `La suma de los movimientos bancarios (${sumBanks.toString()}) no coincide con la suma de Tesorería (${sumTms.toString()}). Si la diferencia es esperada, agregá un ajuste a un rubro de diferencia.`,
      },
      { status: 400 }
    );
  }

  // === Validación A: sibling detection ===
  // Cuando el operador intenta cerrar un match con ajuste y N=1, chequear
  // si la "diferencia" coincide con otra Tesorería sin matchear del mismo
  // cliente. Si sí, devolver warning para que confirme conscientemente.
  if (
    adjustment &&
    uniqueTesoreriaIds.length === 1 &&
    !acknowledgeSiblingWarning
  ) {
    const t = tms[0];
    const dayMs = 24 * 60 * 60 * 1000;
    const lower = new Date(t.fecha.getTime() - SIBLING_WINDOW_DAYS * dayMs);
    const upper = new Date(t.fecha.getTime() + SIBLING_WINDOW_DAYS * dayMs);
    if (t.clienteRut && t.clienteRut !== "55555555-5") {
      const siblings = await prisma.tesoreriaMovement.findMany({
        where: {
          id: { not: t.id },
          clienteRut: t.clienteRut,
          banco: t.banco,
          monto: absDiff,
          fecha: { gte: lower, lte: upper },
          OR: [
            { consolidado: null },
            {
              consolidado: {
                status: { in: ["NO_MATCH", "REVIEW", "OUT_OF_SCOPE"] },
              },
            },
          ],
        },
        select: {
          id: true,
          fecha: true,
          monto: true,
          glosa: true,
          clienteName: true,
        },
        take: 3,
      });
      if (siblings.length > 0) {
        return NextResponse.json(
          {
            warning: "POSSIBLE_SIBLING",
            message: `Hay ${siblings.length === 1 ? "otra tesorería" : `${siblings.length} tesorerías`} sin matchear del mismo cliente cuyo monto coincide con la diferencia. ¿Podría ser parte del mismo depósito?`,
            siblings: siblings.map((s) => ({
              id: s.id,
              fecha: s.fecha.toISOString(),
              monto: s.monto.toString(),
              glosa: s.glosa,
              clienteName: s.clienteName,
            })),
          },
          { status: 409 }
        );
      }
    }
  }

  // === Validación overrideRubroBanco ===
  if (overrideRubroBanco !== undefined && overrideRubroBanco !== null) {
    const rubro = await prisma.rubroLabel.findUnique({
      where: { rubro: overrideRubroBanco },
    });
    if (!rubro) {
      return NextResponse.json(
        { error: `El rubro ${overrideRubroBanco} no existe.` },
        { status: 400 }
      );
    }
  }

  // === Algoritmo de allocations ===
  // N=1: cada link guarda amountAllocated=null (semantics legacy "todo el BM
  //      va a este consolidado"). El consolidado consume sumBanks completo.
  // N>1: greedy. Recorremos tesorerías en orden, y para cada una vamos
  //      consumiendo bms hasta cubrir t.monto.
  const isMultiTm = uniqueTesoreriaIds.length > 1;
  const isSplit = uniqueBankMovementIds.length > 1;

  // matchType:
  //   N=1, M=1                → MANUAL
  //   N=1, M>1                → SPLIT_SAME_DAY (compat)
  //   N>1 (M cualquiera)      → SPLIT_INVERSE_MANUAL
  const matchType: string = isMultiTm
    ? "SPLIT_INVERSE_MANUAL"
    : isSplit
    ? "SPLIT_SAME_DAY"
    : "MANUAL";

  // Orden estable de tesorerías (por fecha asc, id asc) para que el greedy
  // sea determinístico.
  const tmsSorted = tms.slice().sort((a, b) => {
    const da = a.fecha.getTime();
    const db = b.fecha.getTime();
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
  // Bancos también ordenados (por postDate asc, id asc)
  const bmsSorted = bms.slice().sort((a, b) => {
    const da = a.postDate.getTime();
    const db = b.postDate.getTime();
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });

  // links: array de { tmId, bmId, allocated } a crear en la transacción.
  type LinkSpec = { tmId: string; bmId: string; allocated: bigint | null };
  const linksToCreate: LinkSpec[] = [];
  // En split inverso CON ajuste, la tesorería que absorbe la diferencia.
  let adjustmentTmId: string | null = null;

  if (!isMultiTm) {
    // Single-tesorería: cada bm seleccionado va completo (amountAllocated
    // null, semantics legacy). Acepta ajuste — la diferencia se contabiliza
    // en el Consolidado, no en los links.
    for (const bm of bmsSorted) {
      linksToCreate.push({
        tmId: tmsSorted[0].id,
        bmId: bm.id,
        allocated: null,
      });
    }
  } else {
    // Multi-tesorería: greedy con allocations explícitas.
    const remaining = new Map<string, bigint>(
      bmsSorted.map((bm) => [bm.id, bm.amount])
    );
    for (const t of tmsSorted) {
      let need = t.monto;
      for (const bm of bmsSorted) {
        if (need === 0n) break;
        const rem = remaining.get(bm.id) ?? 0n;
        if (rem === 0n) continue;
        const take = rem < need ? rem : need;
        linksToCreate.push({
          tmId: t.id,
          bmId: bm.id,
          allocated: take,
        });
        remaining.set(bm.id, rem - take);
        need -= take;
      }
      if (need !== 0n) {
        // FALTANTE: la cartola sumó menos que las tesorerías. Si hay ajuste y
        // el faltante de ESTA tesorería es exactamente la diferencia, se lo
        // cargamos como ajuste (es la última que quedó corta). Si no, error.
        if (adjustment && adjustmentTmId === null && need === absDiff) {
          adjustmentTmId = t.id;
          need = 0n;
        } else {
          return NextResponse.json(
            {
              error: `Error interno repartiendo allocations (tesorería ${t.id.slice(0, 8)} quedó con ${need.toString()} sin cubrir). Reportá esto.`,
            },
            { status: 500 }
          );
        }
      }
    }

    // EXCEDENTE: la cartola sumó más que las tesorerías. Si hay ajuste y el
    // sobrante es la diferencia, se lo asignamos a la última tesorería.
    const leftover = [...remaining.values()].reduce((a, b) => a + b, 0n);
    if (leftover !== 0n) {
      if (adjustment && leftover === absDiff) {
        const lastTm = tmsSorted[tmsSorted.length - 1];
        for (const bm of bmsSorted) {
          const rem = remaining.get(bm.id) ?? 0n;
          if (rem === 0n) continue;
          linksToCreate.push({ tmId: lastTm.id, bmId: bm.id, allocated: rem });
          remaining.set(bm.id, 0n);
        }
        adjustmentTmId = lastTm.id;
      } else {
        return NextResponse.json(
          {
            error: `Error interno: sobró cartola sin asignar (${leftover.toString()}). Reportá esto.`,
          },
          { status: 500 }
        );
      }
    }
  }

  // === Persistencia ===
  // Para cada tesorería: crear o actualizar su Consolidado y resetear links.
  // Si es N>1 y alguna ya tenía Consolidado, lo wipeamos primero.
  await prisma.$transaction(async (tx) => {
    // Wipe previo: borrar links de los consolidados involucrados.
    if (ownConsolidadoIds.size > 0) {
      await tx.consolidadoLink.deleteMany({
        where: { consolidadoId: { in: Array.from(ownConsolidadoIds) } },
      });
    }

    const accountId = bms[0].accountId;

    // Crear/actualizar un Consolidado por tesorería
    const consolidadoByTmId = new Map<string, string>();
    for (const t of tmsSorted) {
      // 1 tesorería: el ajuste va a su consolidado.
      // Split inverso: el ajuste va a la tesorería que absorbió la diferencia.
      const aplicaAjuste = adjustment && (!isMultiTm || t.id === adjustmentTmId);
      const ajForThis = aplicaAjuste
        ? { adjustmentAmount, adjustmentRubro, adjustmentNote }
        : { adjustmentAmount: null, adjustmentRubro: null, adjustmentNote: null };

      const c = t.consolidado
        ? await tx.consolidado.update({
            where: { id: t.consolidado.id },
            data: {
              status: "MANUAL",
              matchType,
              resolvedAccountId: accountId,
              overrideRubroBanco: overrideRubroBanco ?? null,
              matchedAt: new Date(),
              ...ajForThis,
            },
          })
        : await tx.consolidado.create({
            data: {
              tesoreriaMovementId: t.id,
              status: "MANUAL",
              matchType,
              resolvedAccountId: accountId,
              overrideRubroBanco: overrideRubroBanco ?? null,
              ...ajForThis,
            },
          });
      consolidadoByTmId.set(t.id, c.id);
    }

    // Crear todos los links con su allocation
    await tx.consolidadoLink.createMany({
      data: linksToCreate.map((l) => ({
        consolidadoId: consolidadoByTmId.get(l.tmId)!,
        bankMovementId: l.bmId,
        amountAllocated: l.allocated,
      })),
    });
  });

  return NextResponse.json({ ok: true });
}
