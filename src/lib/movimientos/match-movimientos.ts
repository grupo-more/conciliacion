import { prisma } from "@/lib/db";

/**
 * Matcher de MovimientoCaja (depositos/retiros fisicos) contra la cartola
 * (BankMovement). Determinista y atomico: recalcula TODO en una pasada.
 *
 * Llave: cuenta bancaria + direccion (IN/OUT) + monto exacto + fecha (±N dias).
 * Asignacion greedy bipartita por cercania de fecha; un BankMovement se usa una
 * sola vez. (El abono del banco = el deposito fisico; relacion 1:1.)
 *
 * status resultante:
 *   AUTO_MATCHED → match unico/limpio por monto+fecha+banco
 *   NO_MATCH     → sin contraparte en la ventana
 *   OUT_OF_SCOPE → no se pudo resolver la cuenta bancaria desde `banco`
 *   ANULADO      → el movimiento esta anulado en origen
 */

// Ventana de fecha y tolerancia de monto, configurables por env. Default ±5
// días y 1% — calibrado contra cartola real (sube cobertura de 61% a ~69%).
// Los depósitos suelen acreditar 1-2 días después; la tolerancia cubre redondeos.
const WINDOW_DAYS = Number(process.env.MOVIMIENTOS_MATCH_WINDOW_DAYS) || 5;
const AMOUNT_TOLERANCE = Number(process.env.MOVIMIENTOS_MATCH_TOLERANCE ?? 0.01);

export interface MatchResult {
  ok: boolean;
  total: number;
  autoMatched: number;
  noMatch: number;
  outOfScope: number;
  anulados: number;
  error?: string;
}

function norm(s: string | null | undefined): string {
  // NFD descompone los acentos; el filtro [^A-Z0-9 ] elimina las marcas
  // combinantes resultantes (y cualquier signo), así que no hace falta un
  // replace específico de diacríticos.
  return (s || "")
    .normalize("NFD")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Acct = { id: string; bankName: string; holderName: string };

/**
 * Resuelve el `banco` (ej. "Santander ME", "BCI ME", "Banco Chile ME",
 * "More Capital") a un BankAccount.id. Primero por alias exacto; si no, por
 * coincidencia de tokens contra bankName+holderName de las cuentas.
 */
function buildResolver(accounts: Acct[], aliasMap: Map<string, string>) {
  return (banco: string | null): string | null => {
    if (!banco) return null;
    const direct = aliasMap.get(banco) || aliasMap.get(banco.trim());
    if (direct) return direct;
    const tokens = norm(banco).split(" ").filter((t) => t.length >= 2);
    let best: { id: string; score: number } | null = null;
    for (const a of accounts) {
      const hay = norm(`${a.bankName} ${a.holderName}`);
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score++;
      if (score > 0 && (!best || score > best.score)) best = { id: a.id, score };
    }
    // Exigir que matcheen al menos 2 tokens (ej. "Banco"+"Chile", "More"+"Capital")
    return best && best.score >= 2 ? best.id : null;
  };
}

export async function runMatchMovimientos(): Promise<MatchResult> {
  try {
    const [movs, accounts, aliases, bms] = await Promise.all([
      prisma.movimientoCaja.findMany({
        where: { categoria: { in: ["CAJA_BANCO", "BANCO_BANCO"] } },
        orderBy: { fecha: "asc" },
      }),
      prisma.bankAccount.findMany({ select: { id: true, bankName: true, holderName: true } }),
      prisma.bankAccountAlias.findMany({ select: { bancoString: true, accountId: true } }),
      prisma.bankMovement.findMany({
        select: { id: true, accountId: true, amount: true, direction: true, postDate: true },
      }),
    ]);

    const aliasMap = new Map<string, string>(
      aliases.map((a: { bancoString: string; accountId: string }) => [a.bancoString, a.accountId])
    );
    const resolve = buildResolver(accounts as Acct[], aliasMap);

    // Indice cartola: (accountId, direction) -> [{id, amount, date}]. La llave NO
    // incluye el monto porque ahora matcheamos con tolerancia (no solo exacto).
    const idx = new Map<string, { id: string; amount: number; date: number }[]>();
    for (const b of bms) {
      const amt = b.amount < 0n ? -b.amount : b.amount;
      const key = `${b.accountId}|${b.direction}`;
      (idx.get(key) ?? idx.set(key, []).get(key)!).push({
        id: b.id,
        amount: Number(amt),
        date: b.postDate.getTime(),
      });
    }
    const usedBm = new Set<string>();

    type Upd = { id: string; status: string; matchType: string | null; bankMovementId: string | null; resolvedAccountId: string | null; score: number | null };
    const updates: Upd[] = [];
    let autoMatched = 0, noMatch = 0, outOfScope = 0, anulados = 0;

    for (const m of movs) {
      if (m.anulado || m.estadoActual === "ANU") {
        anulados++;
        updates.push({ id: m.id, status: "ANULADO", matchType: null, bankMovementId: null, resolvedAccountId: null, score: null });
        continue;
      }
      const accountId = resolve(m.banco);
      if (!accountId || !m.direccion) {
        outOfScope++;
        updates.push({ id: m.id, status: "OUT_OF_SCOPE", matchType: null, bankMovementId: null, resolvedAccountId: accountId, score: null });
        continue;
      }
      const key = `${accountId}|${m.direccion}`;
      const target = Number(m.monto);
      const f = m.fecha.getTime();
      // Mejor candidato: primero monto EXACTO, luego fecha más cercana; si no hay
      // exacto, el más cercano en monto dentro de la tolerancia.
      let best: { id: string; days: number; exact: boolean; amtDiff: number } | null = null;
      for (const c of idx.get(key) ?? []) {
        if (usedBm.has(c.id)) continue;
        const days = Math.abs(c.date - f) / 86400000;
        if (days > WINDOW_DAYS) continue;
        const amtDiff = Math.abs(c.amount - target);
        const exact = amtDiff < 1;
        const within = target > 0 && amtDiff / target <= AMOUNT_TOLERANCE;
        if (!exact && !within) continue;
        const better =
          !best ||
          (exact && !best.exact) ||
          (exact === best.exact && (days < best.days || (days === best.days && amtDiff < best.amtDiff)));
        if (better) best = { id: c.id, days, exact, amtDiff };
      }
      if (best) {
        usedBm.add(best.id);
        autoMatched++;
        const days = Math.round(best.days);
        updates.push({
          id: m.id, status: "AUTO_MATCHED",
          matchType: !best.exact ? "TOLERANCIA" : days === 0 ? "EXACT_SAME_DAY" : "EXACT_PM",
          bankMovementId: best.id, resolvedAccountId: accountId,
          // exacto+mismo dia = 100; baja por dias y por no ser exacto.
          score: Math.max(40, 100 - days * 5 - (best.exact ? 0 : 10)),
        });
      } else {
        noMatch++;
        updates.push({ id: m.id, status: "NO_MATCH", matchType: null, bankMovementId: null, resolvedAccountId: accountId, score: null });
      }
    }

    // Persistir en transaccion (chunks para no saturar el pool).
    const CHUNK = 200;
    for (let i = 0; i < updates.length; i += CHUNK) {
      await prisma.$transaction(
        updates.slice(i, i + CHUNK).map((u) =>
          prisma.movimientoCaja.update({
            where: { id: u.id },
            data: {
              status: u.status,
              matchType: u.matchType,
              bankMovementId: u.bankMovementId,
              resolvedAccountId: u.resolvedAccountId,
              score: u.score,
              matchedAt: u.status === "AUTO_MATCHED" ? new Date() : null,
            },
          })
        )
      );
    }

    return { ok: true, total: movs.length, autoMatched, noMatch, outOfScope, anulados };
  } catch (e) {
    return { ok: false, total: 0, autoMatched: 0, noMatch: 0, outOfScope: 0, anulados: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
