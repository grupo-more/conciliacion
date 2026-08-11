/**
 * Verifica si los BankMovement de BACO SPA / MORE CAPITAL que aparecen "Sin
 * conciliar" en Cartolas ya están consumidos por una emisión (típicamente
 * Traspasos internos) — cruza contra EmisionConsumo/EmisionAsientos.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/check-traspaso-baco-morecapital.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });

async function main() {
  const movimientos = await prisma.bankMovement.findMany({
    where: {
      account: { holderName: { contains: "BACO", mode: "insensitive" } },
      description: { contains: "MORE CAPITAL", mode: "insensitive" },
    },
    select: {
      id: true,
      postDate: true,
      amount: true,
      direction: true,
      description: true,
      counterpartyName: true,
      account: { select: { holderName: true, bankName: true } },
    },
    orderBy: { postDate: "desc" },
  });

  if (movimientos.length === 0) {
    console.log("No se encontraron movimientos BACO SPA / MORE CAPITAL.");
    return;
  }

  const ids = movimientos.map((m) => m.id);
  const consumos = await prisma.emisionConsumo.findMany({
    where: { refId: { in: ids } },
    include: { emision: { select: { folio: true, origen: true, createdAt: true } } },
  });
  const emisionPorRef = new Map(consumos.map((c) => [c.refId, c.emision]));

  console.log(`Total movimientos: ${movimientos.length}\n`);
  for (const m of movimientos) {
    const em = emisionPorRef.get(m.id);
    const estado = em
      ? `EMITIDO — folio #${em.folio} (${em.origen}) el ${em.createdAt.toISOString().slice(0, 10)}`
      : "NO emitido (genuinamente pendiente)";
    console.log(
      `${m.postDate.toISOString().slice(0, 10)} | ${m.direction} | $${m.amount} | ` +
        `${m.account.bankName} ${m.account.holderName} | ${m.description} | ${estado}`,
    );
  }

  const emitidosCount = movimientos.filter((m) => emisionPorRef.has(m.id)).length;
  console.log(`\nResumen: ${emitidosCount} de ${movimientos.length} ya están emitidos.`);
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
