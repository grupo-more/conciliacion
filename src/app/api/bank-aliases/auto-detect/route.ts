import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { denyUnless } from "@/lib/perms";

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
 * Reglas de seguridad:
 *   - Solo sugiere si el candidato tiene >= 3 coincidencias y > 60% de
 *     dominancia sobre el segundo mejor.
 *   - Si el candidato sugerido APUNTA A UNA CUENTA QUE YA ESTA MAPEADA POR
 *     OTRO ALIAS, no se autoaplica con `apply=true` (evita duplicados como
 *     "Santander" + "Santander ME" apuntando ambos a 94157609). La sugerencia
 *     se devuelve igual pero marcada con `requiresManualConfirm=true` y el
 *     usuario puede crearla manualmente si confirma que es lo que quiere.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const deniedPerm = await denyUnless(session, "configurar");
  if (deniedPerm) return deniedPerm;

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;

  // Aliases existentes
  const existingAliases = await prisma.bankAccountAlias.findMany({
    select: { bancoString: true, accountId: true },
  });
  const existingBancoStrings = new Set(existingAliases.map((a) => a.bancoString));
  // Mapeo accountId -> bancoStrings que ya lo usan (puede ser >1 ya, en cuyo caso
  // tambien marcamos como conflicto cualquier sugerencia que apunte ahi)
  const aliasesByAccount = new Map<string, string[]>();
  for (const a of existingAliases) {
    const arr = aliasesByAccount.get(a.accountId) ?? [];
    arr.push(a.bancoString);
    aliasesByAccount.set(a.accountId, arr);
  }

  const bancos = await prisma.tesoreriaMovement.findMany({
    where: { banco: { not: null } },
    select: { banco: true },
    distinct: ["banco"],
  });
  const missing = bancos
    .map((b) => b.banco!)
    .filter((b) => b && !existingBancoStrings.has(b));

  if (missing.length === 0) {
    return NextResponse.json({ suggestions: [], applied: 0 });
  }

  const suggestions: Array<{
    bancoString: string;
    suggestion: {
      accountId: string;
      accountNumber: string;
      bankName: string;
      matches: number;
      dominance: number;
    } | null;
    runnerUp?: { accountNumber: string; matches: number } | null;
    reason: string;
    /** Si true, no se autoaplica con `apply=true` (cuenta ya tiene otro alias). */
    requiresManualConfirm?: boolean;
    /** Otros alias que ya apuntan a la cuenta sugerida. */
    accountAlreadyUsedBy?: string[];
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

    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

    if (ranked.length === 0) {
      suggestions.push({
        bancoString: banco,
        suggestion: null,
        reason: "Sin coincidencias en BD",
      });
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
        runnerUp: acc
          ? { accountNumber: acc.accountNumber, matches: runnerCount ?? 0 }
          : null,
      });
      continue;
    }

    const acc = await prisma.bankAccount.findUnique({ where: { id: bestId } });
    if (!acc) continue;

    const otherAliases = aliasesByAccount.get(bestId) ?? [];
    if (otherAliases.length > 0) {
      // La cuenta sugerida ya esta mapeada por otro(s) alias.
      // No autoaplicamos para evitar duplicados accidentales.
      suggestions.push({
        bancoString: banco,
        suggestion: {
          accountId: acc.id,
          accountNumber: acc.accountNumber,
          bankName: acc.bankName,
          matches: bestCount,
          dominance: Math.round(dominance * 100),
        },
        reason: `${bestCount} coincidencias, ${Math.round(dominance * 100)}% dominancia · ⚠ Cuenta ya usada por: ${otherAliases.join(", ")}`,
        requiresManualConfirm: true,
        accountAlreadyUsedBy: otherAliases,
      });
      continue;
    }

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
  let skipped = 0;
  if (apply) {
    for (const s of suggestions) {
      if (!s.suggestion) continue;
      if (s.requiresManualConfirm) {
        skipped++;
        continue;
      }
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
        // ignore duplicates (race)
      }
    }
  }

  return NextResponse.json({ suggestions, applied, skipped });
}
