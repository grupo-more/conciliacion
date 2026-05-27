import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/bank-aliases/auto-detect
 *
 * Sugerencia automatica de alias: para cada banco_string de Tesoreria que
 * no tiene alias, computa cual BankAccount es el candidato mas probable
 * mirando los movimientos con mismo monto+fecha que ya estan en la BD.
 *
 * Body: { apply?: boolean }
 *   - apply=false (default): solo devuelve sugerencias
 *   - apply=true: inserta los alias detectados automaticamente
 *
 * La heuristica: por cada banco_string, contar cuantos BankMovements
 * coinciden en monto y dentro de +/-7 dias para cada cuenta. La cuenta
 * con mas coincidencias es la sugerencia. Solo sugiere si tiene >= 3
 * coincidencias y > 60% de dominancia sobre la segunda mejor.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;

  // Bancos de Tesoreria sin alias
  const existing = await prisma.bankAccountAlias.findMany({ select: { bancoString: true } });
  const existingSet = new Set(existing.map((a) => a.bancoString));

  const bancos = await prisma.tesoreriaMovement.findMany({
    where: { banco: { not: null } },
    select: { banco: true },
    distinct: ["banco"],
  });
  const missing = bancos.map((b) => b.banco!).filter((b) => b && !existingSet.has(b));

  if (missing.length === 0) {
    return NextResponse.json({ suggestions: [], applied: 0 });
  }

  const suggestions: Array<{
    bancoString: string;
    suggestion: { accountId: string; accountNumber: string; bankName: string; matches: number; dominance: number } | null;
    runnerUp?: { accountNumber: string; matches: number } | null;
    reason: string;
  }> = [];

  for (const banco of missing) {
    // Movimientos Tesoreria con este banco
    const tList = await prisma.tesoreriaMovement.findMany({
      where: { banco },
      select: { id: true, monto: true, fecha: true },
    });

    // Contar matches por cuenta
    const counts = new Map<string, number>();
    for (const t of tList) {
      const dayMs = 24 * 60 * 60 * 1000;
      const lower = new Date(t.fecha.getTime() - 7 * dayMs);
      const upper = new Date(t.fecha.getTime() + 7 * dayMs);
      const bms = await prisma.bankMovement.findMany({
        where: {
          direction: "IN",
          amount: t.monto,
          postDate: { gte: lower, lte: upper },
        },
        select: { accountId: true },
      });
      for (const bm of bms) {
        counts.set(bm.accountId, (counts.get(bm.accountId) ?? 0) + 1);
      }
    }

    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1]);

    if (ranked.length === 0) {
      suggestions.push({ bancoString: banco, suggestion: null, reason: "Sin coincidencias en BD" });
      continue;
    }

    const [bestId, bestCount] = ranked[0];
    const [, runnerCount] = ranked[1] ?? [null, 0];
    const dominance = bestCount > 0 ? bestCount / (bestCount + (runnerCount ?? 0)) : 0;

    if (bestCount < 3) {
      suggestions.push({
        bancoString: banco,
        suggestion: null,
        reason: `Solo ${bestCount} coincidencias (umbral mínimo 3)`,
      });
      continue;
    }

    if (dominance < 0.6) {
      const acc = await prisma.bankAccount.findUnique({ where: { id: bestId } });
      suggestions.push({
        bancoString: banco,
        suggestion: null,
        reason: `Empate (${bestCount} vs ${runnerCount}). Asignar manualmente.`,
        runnerUp: acc ? { accountNumber: acc.accountNumber, matches: runnerCount ?? 0 } : null,
      });
      continue;
    }

    const acc = await prisma.bankAccount.findUnique({ where: { id: bestId } });
    if (!acc) continue;

    suggestions.push({
      bancoString: banco,
      suggestion: {
        accountId: acc.id,
        accountNumber: acc.accountNumber,
        bankName: acc.bankName,
        matches: bestCount,
        dominance: Math.round(dominance * 100),
      },
      reason: `${bestCount} coincidencias, ${Math.round(dominance * 100)}% dominancia`,
    });
  }

  let applied = 0;
  if (apply) {
    for (const s of suggestions) {
      if (!s.suggestion) continue;
      try {
        await prisma.bankAccountAlias.create({
          data: {
            bancoString: s.bancoString,
            accountId: s.suggestion.accountId,
            notes: `Auto-detectado: ${s.reason}`,
          },
        });
        applied++;
      } catch {
        // ignore duplicates
      }
    }
  }

  return NextResponse.json({ suggestions, applied });
}
