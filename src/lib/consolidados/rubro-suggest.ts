/**
 * Sugiere el "rubro banco" contable para cuentas bancarias.
 *
 * Se usa cuando un match es cross-banco (la cuenta real ≠ el banco que mandó la
 * API en rubroBanco): el asiento debe contabilizarse en el rubro de la cuenta
 * REAL, no en el que vino de Tesorería. El operador confirma este sugerido al
 * vincular (override `Consolidado.overrideRubroBanco`).
 *
 * Estrategia (igual que la tab Comparar):
 *   1. Aprendizaje: el override más usado históricamente para esa cuenta en
 *      matches AUTO/MANUAL previos.
 *   2. Catálogo: match por nombre (bankName + holderName) contra el nombre de
 *      un RubroLabel no-isDifference.
 */
import { prisma } from "@/lib/db";

export async function suggestRubroForAccounts(
  accountIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const ids = Array.from(new Set(accountIds)).filter(Boolean);
  if (ids.length === 0) return result;

  // (1) Aprendizaje por overrides previos.
  const historico = await prisma.consolidado.findMany({
    where: {
      status: { in: ["AUTO_MATCHED", "MANUAL"] },
      resolvedAccountId: { in: ids },
      overrideRubroBanco: { not: null },
    },
    select: { resolvedAccountId: true, overrideRubroBanco: true },
  });
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
    if (best !== null) result.set(accId, best);
  }

  // (2) Match por nombre del catálogo para las que no tienen override previo.
  const without = ids.filter((id) => !result.has(id));
  if (without.length > 0) {
    const [accDetails, rubrosCat] = await Promise.all([
      prisma.bankAccount.findMany({
        where: { id: { in: without } },
        select: { id: true, bankName: true, holderName: true },
      }),
      prisma.rubroLabel.findMany({
        where: { isDifference: false },
        select: { rubro: true, name: true },
      }),
    ]);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    for (const acc of accDetails) {
      const accKey = norm(`${acc.bankName} ${acc.holderName}`);
      const exact = rubrosCat.find((r) => norm(r.name) === accKey);
      if (exact) {
        result.set(acc.id, exact.rubro);
        continue;
      }
      const partial = rubrosCat.find((r) => {
        const rn = norm(r.name);
        return rn.length >= 3 && (accKey.includes(rn) || rn.includes(accKey));
      });
      if (partial) result.set(acc.id, partial.rubro);
    }
  }

  return result;
}
