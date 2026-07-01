import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { detectInterno, loadEntidadesInternas } from "@/lib/internos/detect";
import { usoParcialAccountWhere } from "@/lib/cuentas/uso-parcial";

/**
 * GET /api/consolidados/egresos-terceros?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &accountId=<uuid>&q=<search>&quality=con_rut|solo_nombre|sin_info
 *
 * Lista los OUT del rango que NO matchean ninguna entidad interna registrada
 * (egresos a terceros). El lado interno de los OUT vive ahora en la tab
 * "Traspasos internos" (cruce OUT↔IN espejo); juntos == todos los OUT del rango.
 *
 * Cada fila trae un "quality" derivado de los datos de contraparte que vinieron
 * en la cartola:
 *   - con_rut       → counterpartyRut presente.
 *   - solo_nombre   → counterpartyRut vacio pero counterpartyName presente.
 *   - sin_info      → ninguno de los dos vino (queda solo la glosa para investigar).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const { from, to } = parseRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  const accountId = url.searchParams.get("accountId") || null;
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const quality = url.searchParams.get("quality") as Quality | null;

  const entidades = await loadEntidadesInternas(prisma);

  // Propuestas SUGGESTED del motor de egresos: no crean link, pero apuntan a
  // movimiento(s) de banco vía proposalJson. Las indexamos por bankMovementId
  // para badgear el OUT como "sugerido" aunque no esté vinculado.
  const suggested = await prisma.egresoConciliacion.findMany({
    where: { status: "SUGGESTED" },
    select: {
      score: true,
      proposalJson: true,
      egresoMovement: { select: { externalId: true, glosa: true, monto: true, rubroNombre: true } },
    },
  });
  const suggByBm = new Map<string, (typeof suggested)[number]>();
  for (const s of suggested) {
    const ids = (s.proposalJson as { bankMovementIds?: string[] } | null)?.bankMovementIds ?? [];
    for (const id of ids) if (!suggByBm.has(id)) suggByBm.set(id, s);
  }

  const movements = await prisma.bankMovement.findMany({
    where: {
      direction: "OUT",
      postDate: { gte: from, lt: to },
      ...(accountId ? { accountId } : {}),
      descartadoAt: null,
      // Cuentas de uso parcial: fuera de scope (solo importan sus traspasos).
      account: { isNot: usoParcialAccountWhere },
    },
    include: {
      account: {
        select: {
          id: true,
          bankCode: true,
          bankName: true,
          accountNumber: true,
          displayNumber: true,
          holderName: true,
          alias: true,
        },
      },
      // Estado de conciliacion contra el egreso de Dynatech (Tesorería), si existe.
      consolidadoLinks: {
        select: {
          consolidado: {
            select: {
              status: true,
              matchType: true,
              tesoreriaMovement: { select: { externalId: true } },
            },
          },
        },
        take: 1,
      },
      // Conciliacion contra gasto operativo (EgresoMovement), si existe.
      egresoConciliacionLinks: {
        select: {
          conciliacion: {
            select: {
              status: true,
              score: true,
              egresoMovement: {
                select: { externalId: true, glosa: true, monto: true, rubroNombre: true },
              },
            },
          },
        },
        take: 1,
      },
    },
    orderBy: [{ postDate: "desc" }, { createdAt: "desc" }],
    take: 10000,
  });

  const rows: EgresoTerceroRow[] = [];
  let totalMonto = 0n;
  const qualityCount: Record<Quality, number> = {
    con_rut: 0,
    solo_nombre: 0,
    sin_info: 0,
  };

  for (const bm of movements) {
    // Si matchea una entidad interna, pertenece al OTRO tab.
    const internoMatch = detectInterno(bm, entidades);
    if (internoMatch) continue;

    const hasRut = !!bm.counterpartyRut && bm.counterpartyRut.trim().length > 0;
    const hasName =
      !!bm.counterpartyName && bm.counterpartyName.trim().length > 0;
    const rowQuality: Quality = hasRut
      ? "con_rut"
      : hasName
        ? "solo_nombre"
        : "sin_info";
    qualityCount[rowQuality]++;

    if (quality && rowQuality !== quality) continue;

    if (q) {
      const haystack = [
        bm.counterpartyName,
        bm.counterpartyRut,
        bm.description,
      ]
        .filter((s): s is string => !!s)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }

    const abs = bm.amount < 0n ? -bm.amount : bm.amount;
    totalMonto += abs;

    const cuentaNumero = bm.account.displayNumber || bm.account.accountNumber;

    const cLink = bm.consolidadoLinks[0]?.consolidado ?? null;
    const conciliacion = cLink
      ? {
          status: cLink.status,
          matchType: cLink.matchType,
          tesoreriaExternalId: cLink.tesoreriaMovement.externalId.toString(),
        }
      : null;

    const eConc = bm.egresoConciliacionLinks[0]?.conciliacion ?? null;
    // Si el OUT ya está conciliado (AUTO/MANUAL) contra Tesorería, una
    // propuesta SUGGESTED de gasto no debe pisar ese estado en el badge.
    const tesoreriaConfirmed =
      cLink?.status === "AUTO_MATCHED" || cLink?.status === "MANUAL";
    const sugg = !eConc && !tesoreriaConfirmed ? suggByBm.get(bm.id) : null;
    const egresoConciliacion = eConc
      ? {
          status: eConc.status,
          score: eConc.score,
          egresoExternalId: eConc.egresoMovement.externalId.toString(),
          egresoGlosa: eConc.egresoMovement.glosa,
          egresoMonto: eConc.egresoMovement.monto.toString(),
          rubroNombre: eConc.egresoMovement.rubroNombre,
        }
      : sugg
        ? {
            status: "SUGGESTED",
            score: sugg.score,
            egresoExternalId: sugg.egresoMovement.externalId.toString(),
            egresoGlosa: sugg.egresoMovement.glosa,
            egresoMonto: sugg.egresoMovement.monto.toString(),
            rubroNombre: sugg.egresoMovement.rubroNombre,
          }
        : null;

    rows.push({
      id: bm.id,
      fecha: bm.postDate.toISOString(),
      accountId: bm.account.id,
      bankName: bm.account.bankName,
      holderName: bm.account.holderName,
      accountNumber: cuentaNumero,
      monto: abs.toString(),
      counterpartyRut: bm.counterpartyRut,
      counterpartyName: bm.counterpartyName,
      description: bm.description,
      quality: rowQuality,
      conciliacion,
      egresoConciliacion,
    });
  }

  // Facets: cuentas vistas en el rango (sin filtro de cuenta) entre los OUT no
  // internos. Lo recomputamos sobre el set completo aunque haya filtros, para
  // que los selects sigan teniendo todas las opciones.
  const accountIds = new Set<string>();
  for (const bm of movements) {
    if (detectInterno(bm, entidades)) continue;
    accountIds.add(bm.accountId);
  }
  const accountList =
    accountIds.size > 0
      ? await prisma.bankAccount.findMany({
          where: { id: { in: [...accountIds] } },
          select: {
            id: true,
            bankName: true,
            displayNumber: true,
            accountNumber: true,
            holderName: true,
          },
        })
      : [];

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    rows,
    totals: { count: rows.length, monto: totalMonto.toString() },
    qualityCount,
    facets: {
      accounts: accountList
        .map((a) => ({
          id: a.id,
          label: `${a.holderName} · ${a.displayNumber || a.accountNumber} (${a.bankName})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
  });
}

type Quality = "con_rut" | "solo_nombre" | "sin_info";

interface EgresoTerceroRow {
  id: string;
  fecha: string;
  accountId: string;
  bankName: string;
  holderName: string;
  accountNumber: string;
  monto: string;
  counterpartyRut: string | null;
  counterpartyName: string | null;
  description: string | null;
  quality: Quality;
  conciliacion: {
    status: string;
    matchType: string | null;
    tesoreriaExternalId: string;
  } | null;
  egresoConciliacion: {
    status: string;
    score: number | null;
    egresoExternalId: string;
    egresoGlosa: string;
    egresoMonto: string;
    rubroNombre: string | null;
  } | null;
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null,
): { from: Date; to: Date } {
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
