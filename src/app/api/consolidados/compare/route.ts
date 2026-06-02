import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getDifMenorSettings } from "@/lib/dif-menor/detect";

/**
 * GET /api/consolidados/compare
 *
 * Devuelve datos para la vista comparativa side-by-side:
 *  - bankMovements: BankMovements (IN) en el rango
 *  - tesoreriaMovements: TesoreriaMovements en el rango con su Consolidado
 *  - accounts: catalogo para filtros
 *
 * Por defecto solo los "abiertos" (NO_MATCH / REVIEW / OUT_OF_SCOPE para
 * Tesoreria, sin link para Bank). Con onlyUnmatched=false trae todos.
 *
 * Filtros:
 *  ?since=YYYY-MM-DD
 *  ?until=YYYY-MM-DD
 *  ?accountId=<uuid>   filtra BankMovements a una cuenta especifica
 *  ?banco=<string>     filtra Tesoreria por banco
 *  ?onlyUnmatched=true (default) o false
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const untilRaw = url.searchParams.get("until");
  const accountId = url.searchParams.get("accountId");
  const banco = (url.searchParams.get("banco") || "").trim();
  const onlyUnmatched = url.searchParams.get("onlyUnmatched") !== "false";

  // Default: ultimos 30 dias
  const now = new Date();
  const since = sinceRaw
    ? new Date(sinceRaw)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const until = untilRaw
    ? new Date(untilRaw + "T23:59:59")
    : new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Bank movements
  // Excluimos de Comparar tanto Transbank como las "diferencias menores":
  // ambos tienen asiento contable propio en Consolidados y no se concilian
  // contra Tesorería, así que no tienen nada que comparar acá.
  const difSettings = await getDifMenorSettings();
  const bankWhere: Prisma.BankMovementWhereInput = {
    direction: "IN",
    postDate: { gte: since, lte: until },
    ...(accountId ? { accountId } : {}),
    ...(onlyUnmatched ? { consolidadoLinks: { none: {} } } : {}),
    NOT: [
      {
        AND: [
          { description: { contains: "abn crd", mode: "insensitive" } },
          { description: { contains: "transba", mode: "insensitive" } },
        ],
      },
      {
        amount: { gt: 0n, lte: BigInt(difSettings.threshold) },
      },
    ],
  };
  const bankMovements = await prisma.bankMovement.findMany({
    where: bankWhere,
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
      consolidadoLinks: {
        select: { consolidadoId: true },
        take: 1,
      },
    },
    orderBy: [{ postDate: "desc" }, { amount: "desc" }],
    take: 1000,
  });

  // Tesoreria movements
  const tesoreriaWhere = {
    fecha: { gte: since, lte: until },
    ...(banco ? { banco } : {}),
    ...(onlyUnmatched
      ? {
          OR: [
            { consolidado: null },
            {
              consolidado: {
                status: { in: ["NO_MATCH", "REVIEW", "OUT_OF_SCOPE"] },
              },
            },
          ],
        }
      : {}),
  } as const;
  const tesoreriaMovements = await prisma.tesoreriaMovement.findMany({
    where: tesoreriaWhere,
    include: {
      consolidado: {
        select: { id: true, status: true, score: true, matchType: true },
      },
    },
    orderBy: [{ fecha: "desc" }, { monto: "desc" }],
    take: 1000,
  });

  // Catalogo de cuentas para filtros
  const accounts = await prisma.bankAccount.findMany({
    where: { active: true },
    select: {
      id: true,
      bankCode: true,
      bankName: true,
      accountNumber: true,
      displayNumber: true,
      holderName: true,
      alias: true,
    },
    orderBy: [{ bankCode: "asc" }, { accountNumber: "asc" }],
  });

  // Bancos distintos en Tesoreria (para filtro)
  const bancosRows = await prisma.tesoreriaMovement.findMany({
    where: { banco: { not: null } },
    select: { banco: true },
    distinct: ["banco"],
  });
  const bancos = bancosRows.map((b) => b.banco!).filter(Boolean).sort();

  // Rubro sugerido por cuenta bancaria. Se infiere SOLO desde info de la
  // cartola (no de TesoreriaMovement.rubroBanco que puede estar mal cuando
  // la sucursal tipeó mal el banco). Estrategia en 2 niveles:
  //
  //   1) Override previo: si el operador ya hizo overrides en matches anteriores
  //      para esta cuenta, sugerimos el rubro más usado (la moda de overrides).
  //
  //   2) Match por nombre del catálogo: buscar un RubroLabel cuyo `name`
  //      contenga el bankName + holderName de la cuenta (ej. cuenta BCI ME SPA
  //      matchea con rubro "BCI ME"). Excluye los rubros marcados como
  //      isDifference (esos son para ajustes, no para banco/sucursal).
  //
  // Si ninguna estrategia da resultado, no hay sugerencia y el operador elige.
  const accountIdsInUse = Array.from(
    new Set(bankMovements.map((bm) => bm.accountId))
  );

  const suggestedRubroByAccount = new Map<string, number>();

  // (1) Aprendizaje por overrides previos
  const historico =
    accountIdsInUse.length > 0
      ? await prisma.consolidado.findMany({
          where: {
            status: { in: ["AUTO_MATCHED", "MANUAL"] },
            resolvedAccountId: { in: accountIdsInUse },
            overrideRubroBanco: { not: null },
          },
          select: {
            resolvedAccountId: true,
            overrideRubroBanco: true,
          },
        })
      : [];
  const counts = new Map<string, Map<number, number>>();
  for (const c of historico) {
    const accId = c.resolvedAccountId;
    const rubro = c.overrideRubroBanco;
    if (!accId || rubro === null) continue;
    if (!counts.has(accId)) counts.set(accId, new Map());
    const m = counts.get(accId)!;
    m.set(rubro, (m.get(rubro) ?? 0) + 1);
  }
  for (const [accId, rubroCounts] of counts) {
    let best: number | null = null;
    let bestCount = 0;
    for (const [rubro, count] of rubroCounts) {
      if (count > bestCount) {
        bestCount = count;
        best = rubro;
      }
    }
    if (best !== null) suggestedRubroByAccount.set(accId, best);
  }

  // (2) Match por nombre del catálogo para las cuentas que no tienen
  // override previo.
  const accountsWithoutSuggestion = accountIdsInUse.filter(
    (id) => !suggestedRubroByAccount.has(id)
  );
  if (accountsWithoutSuggestion.length > 0) {
    // Cargar info de las cuentas (necesitamos holderName + bankName) y los
    // rubros candidatos (los no-isDifference).
    const [accDetails, rubrosCat] = await Promise.all([
      prisma.bankAccount.findMany({
        where: { id: { in: accountsWithoutSuggestion } },
        select: {
          id: true,
          bankName: true,
          holderName: true,
        },
      }),
      prisma.rubroLabel.findMany({
        where: { isDifference: false },
        select: { rubro: true, name: true },
      }),
    ]);
    const norm = (s: string) =>
      s.toLowerCase().replace(/\s+/g, " ").trim();
    for (const acc of accDetails) {
      const accKey = norm(`${acc.bankName} ${acc.holderName}`);
      // Buscamos el rubro cuyo nombre normalizado matchee el accKey (igualdad
      // exacta primero, luego "contains" en cualquier dirección).
      const exact = rubrosCat.find((r) => norm(r.name) === accKey);
      if (exact) {
        suggestedRubroByAccount.set(acc.id, exact.rubro);
        continue;
      }
      const partial = rubrosCat.find((r) => {
        const rn = norm(r.name);
        return rn.length >= 3 && (accKey.includes(rn) || rn.includes(accKey));
      });
      if (partial) suggestedRubroByAccount.set(acc.id, partial.rubro);
    }
  }

  return NextResponse.json({
    bankMovements: bankMovements.map((bm) => ({
      id: bm.id,
      postDate: bm.postDate.toISOString(),
      amount: bm.amount.toString(),
      description: bm.description,
      counterpartyName: bm.counterpartyName,
      counterpartyRut: bm.counterpartyRut,
      account: {
        ...bm.account,
        suggestedRubro: suggestedRubroByAccount.get(bm.accountId) ?? null,
      },
      isLinked: bm.consolidadoLinks.length > 0,
    })),
    tesoreriaMovements: tesoreriaMovements.map((t) => ({
      id: t.id,
      externalId: t.externalId.toString(),
      fecha: t.fecha.toISOString(),
      monto: t.monto.toString(),
      glosa: t.glosa,
      banco: t.banco,
      clienteName: t.clienteName,
      clienteRut: t.clienteRut,
      sucursalName: t.sucursalName,
      esExcepcion: t.esExcepcion,
      consolidado: t.consolidado,
    })),
    accounts,
    bancos,
    range: {
      since: since.toISOString(),
      until: until.toISOString(),
    },
  });
}
