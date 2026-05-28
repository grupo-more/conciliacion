/**
 * scripts/rebuild-dedup-keys.ts
 *
 * Recalcula el `dedup_key` de TODOS los BankMovement con la nueva lógica
 * (REF → EXT → FULL). Detecta los pares que la lógica vieja había dejado
 * pasar como "no duplicados" y los reduce a uno solo (preserva el que tiene
 * ConsolidadoLink; si ninguno tiene, preserva el más antiguo).
 *
 * Uso:
 *   npx tsx scripts/rebuild-dedup-keys.ts            # DRY-RUN (no toca nada)
 *   npx tsx scripts/rebuild-dedup-keys.ts --apply    # Aplica cambios
 *
 * El script imprime un reporte detallado antes de aplicar. En modo --apply
 * todo corre en UNA transacción: si algo falla, se hace rollback completo.
 */

import { prisma } from "@/lib/db";
import { computeDedupKeys } from "@/lib/cartolas/dedup";
import type { NormalizedMovement } from "@/lib/cartolas/types";

const APPLY = process.argv.includes("--apply");

interface BMRow {
  id: string;
  accountId: string;
  externalId: string | null;
  postDate: Date;
  transactionDate: Date | null;
  amount: bigint;
  currency: string;
  direction: string;
  description: string;
  balanceAfter: bigint | null;
  counterpartyName: string | null;
  counterpartyRut: string | null;
  counterpartyAccount: string | null;
  counterpartyBank: string | null;
  branchLabel: string | null;
  txType: string | null;
  dedupKey: string;
  createdAt: Date;
  rawRow: unknown;
  hasLink: boolean;
}

async function main() {
  console.log(`Modo: ${APPLY ? "APPLY (escribe cambios)" : "DRY-RUN (no toca BD)"}`);
  console.log("");

  // 1) Cargar todos los BankMovement con flag de si tienen ConsolidadoLink
  const all = await prisma.bankMovement.findMany({
    include: {
      consolidadoLinks: { select: { id: true } },
    },
    orderBy: [{ accountId: "asc" }, { createdAt: "asc" }],
  });
  console.log(`Movimientos totales: ${all.length}`);

  const rows: BMRow[] = all.map((m) => ({
    id: m.id,
    accountId: m.accountId,
    externalId: m.externalId,
    postDate: m.postDate,
    transactionDate: m.transactionDate,
    amount: m.amount,
    currency: m.currency,
    direction: m.direction,
    description: m.description,
    balanceAfter: m.balanceAfter,
    counterpartyName: m.counterpartyName,
    counterpartyRut: m.counterpartyRut,
    counterpartyAccount: m.counterpartyAccount,
    counterpartyBank: m.counterpartyBank,
    branchLabel: m.branchLabel,
    txType: m.txType,
    dedupKey: m.dedupKey,
    createdAt: m.createdAt,
    rawRow: m.rawRow,
    hasLink: m.consolidadoLinks.length > 0,
  }));

  // 2) Agrupar por accountId y recomputar dedup_key con la nueva función
  //    (preserva el orden con createdAt para que los ordinales por colisión
  //    legítima queden estables)
  const byAccount = new Map<string, BMRow[]>();
  for (const r of rows) {
    const arr = byAccount.get(r.accountId) ?? [];
    arr.push(r);
    byAccount.set(r.accountId, arr);
  }

  const newKeyById = new Map<string, string>();
  for (const [, list] of byAccount) {
    const normalized: NormalizedMovement[] = list.map((r) => ({
      externalId: r.externalId,
      postDate: r.postDate,
      transactionDate: r.transactionDate,
      amount: Number(r.amount),
      currency: r.currency,
      direction: r.direction as "IN" | "OUT",
      description: r.description,
      balanceAfter: r.balanceAfter !== null ? Number(r.balanceAfter) : null,
      counterpartyName: r.counterpartyName,
      counterpartyRut: r.counterpartyRut,
      counterpartyAccount: r.counterpartyAccount,
      counterpartyBank: r.counterpartyBank,
      branchLabel: r.branchLabel,
      txType: r.txType,
      rawRow: (r.rawRow as Record<string, unknown>) ?? {},
    }));
    const newKeys = computeDedupKeys(normalized);
    list.forEach((r, i) => newKeyById.set(r.id, newKeys[i]));
  }

  // 3) Detectar grupos por (accountId, newKey)
  const groupKey = (r: BMRow) => `${r.accountId}::${newKeyById.get(r.id)}`;
  const groups = new Map<string, BMRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  // 4) Para cada grupo size > 1: elegir ganador, marcar perdedores
  const toDelete: BMRow[] = [];
  const toUpdate: BMRow[] = []; // los que cambian su dedup_key (incluye ganadores y singles)

  for (const [, list] of groups) {
    if (list.length === 1) {
      const r = list[0];
      const newKey = newKeyById.get(r.id)!;
      if (newKey !== r.dedupKey) toUpdate.push(r);
    } else {
      // Ganador: prefiere el que tiene ConsolidadoLink; si nadie tiene, el más antiguo
      const withLink = list.filter((r) => r.hasLink);
      const winner =
        withLink.length > 0
          ? withLink[0]
          : list.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

      // Si hay 2+ con link, eso indica un problema previo (un BM con 2 consolidados es ilegal).
      // En ese caso, conservamos todos los que tienen link (no podemos elegir uno arbitrario).
      const keepIds = new Set(withLink.length > 1 ? withLink.map((r) => r.id) : [winner.id]);

      for (const r of list) {
        if (keepIds.has(r.id)) {
          const newKey = newKeyById.get(r.id)!;
          if (newKey !== r.dedupKey) toUpdate.push(r);
        } else {
          toDelete.push(r);
        }
      }
    }
  }

  // 5) Reporte
  console.log("");
  console.log("=".repeat(60));
  console.log("REPORTE");
  console.log("=".repeat(60));
  console.log(`dedup_keys que cambian: ${toUpdate.length}`);
  console.log(`BankMovements a BORRAR (duplicados): ${toDelete.length}`);
  console.log("");

  if (toDelete.length > 0) {
    console.log("--- Detalle de movimientos a borrar ---");
    // Agrupar por (accountId, newKey) para mostrar pares
    const byNewKey = new Map<string, BMRow[]>();
    for (const r of toDelete) {
      const k = groupKey(r);
      const arr = byNewKey.get(k) ?? [];
      arr.push(r);
      byNewKey.set(k, arr);
    }
    let group = 1;
    for (const [k, dels] of byNewKey) {
      // Recuperar el grupo entero (incluye el ganador) para contexto
      const full = groups.get(k)!;
      const winner = full.find((r) => !dels.includes(r));
      console.log(`\n#${group++} grupo (${full.length} movs):`);
      console.log(`  newKey: ${newKeyById.get(full[0].id)}`);
      console.log(`  Fecha: ${full[0].postDate.toISOString().slice(0, 10)}  Monto: ${full[0].amount}  Contraparte: ${full[0].counterpartyName ?? "—"}  ExternalId: ${full[0].externalId ?? "—"}`);
      console.log(
        `  GANADOR (se conserva): ${winner?.id} ${winner?.hasLink ? "(con ConsolidadoLink)" : "(más antiguo)"}`
      );
      for (const d of dels) {
        console.log(`  BORRAR: ${d.id} hasLink=${d.hasLink} dedupKey=${d.dedupKey} importedAt=${d.createdAt.toISOString()}`);
      }
    }
  }

  // 6) Aplicar si --apply
  if (!APPLY) {
    console.log("");
    console.log("DRY-RUN terminado. Para aplicar, corré con --apply");
    return;
  }

  console.log("");
  console.log("APLICANDO CAMBIOS EN UNA TRANSACCIÓN...");

  // Para evitar conflictos transitorios con el unique (accountId, dedup_key)
  // hacemos los updates en dos fases:
  //   Fase A: cada update va a un valor temporal único (TEMP::<id>) — nunca choca.
  //   Fase B: cada update va al newKey definitivo — tampoco choca porque los
  //   perdedores ya se borraron en el paso 1 y los demás ya están en TEMP.
  await prisma.$transaction(
    async (tx) => {
      // 1) Borrar perdedores
      for (const r of toDelete) {
        await tx.bankMovement.delete({ where: { id: r.id } });
      }
      // 2.A) Fase intermedia: dedup_key temporal
      for (const r of toUpdate) {
        await tx.bankMovement.update({
          where: { id: r.id },
          data: { dedupKey: `TEMP::${r.id}` },
        });
      }
      // 2.B) Fase final: dedup_key definitivo
      for (const r of toUpdate) {
        const newKey = newKeyById.get(r.id)!;
        await tx.bankMovement.update({
          where: { id: r.id },
          data: { dedupKey: newKey },
        });
      }
    },
    { timeout: 60_000 }
  );

  console.log(`OK. Borrados: ${toDelete.length}. Actualizados: ${toUpdate.length}.`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
