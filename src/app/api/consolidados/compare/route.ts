import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

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
  const bankWhere = {
    direction: "IN",
    postDate: { gte: since, lte: until },
    ...(accountId ? { accountId } : {}),
    ...(onlyUnmatched ? { consolidadoLinks: { none: {} } } : {}),
  } as const;
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

  // Rubro sugerido por cuenta bancaria. Lo aprendemos del historial de
  // Consolidados conciliados (AUTO_MATCHED + MANUAL): para cada cuenta,
  // qué rubro_banco aparece más veces. Si el operador hizo overrides,
  // esos ganan (porque son la corrección humana). Sirve como default
  // del select "Rubro banco (asiento OK)" en el match manual.
  const accountIdsInUse = Array.from(
    new Set(bankMovements.map((bm) => bm.accountId))
  );
  const historico =
    accountIdsInUse.length > 0
      ? await prisma.consolidado.findMany({
          where: {
            status: { in: ["AUTO_MATCHED", "MANUAL"] },
            resolvedAccountId: { in: accountIdsInUse },
          },
          select: {
            resolvedAccountId: true,
            overrideRubroBanco: true,
            tesoreriaMovement: { select: { rubroBanco: true } },
          },
        })
      : [];
  const counts = new Map<string, Map<number, number>>();
  for (const c of historico) {
    const accId = c.resolvedAccountId;
    if (!accId) continue;
    const rubro = c.overrideRubroBanco ?? c.tesoreriaMovement.rubroBanco;
    if (rubro === null) continue;
    if (!counts.has(accId)) counts.set(accId, new Map());
    const m = counts.get(accId)!;
    m.set(rubro, (m.get(rubro) ?? 0) + 1);
  }
  const suggestedRubroByAccount = new Map<string, number>();
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
