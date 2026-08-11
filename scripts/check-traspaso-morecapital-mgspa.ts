/**
 * Muestra los BankMovement reales (dirección, glosa, monto, fecha) de las
 * cuentas MORECAPITAL (Banco Internacional) y MG SPA (Santander) alrededor
 * del 10-08-2026, para verificar si el par de $7.000.000 que armó "Traspasos
 * internos" (Emisión #190) tiene el DEBE/HABER como corresponde según la
 * dirección real de cada cartola.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/check-traspaso-morecapital-mgspa.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });

async function main() {
  const movimientos = await prisma.bankMovement.findMany({
    where: {
      account: {
        OR: [
          { holderName: { contains: "MORECAPITAL", mode: "insensitive" } },
          { holderName: { contains: "MG SPA", mode: "insensitive" } },
        ],
      },
      amount: { in: [7000000n, -7000000n] },
      postDate: { gte: new Date("2026-08-08"), lt: new Date("2026-08-12") },
    },
    select: {
      id: true,
      postDate: true,
      amount: true,
      direction: true,
      description: true,
      counterpartyName: true,
      counterpartyRut: true,
      account: { select: { bankName: true, holderName: true, displayNumber: true, accountNumber: true } },
    },
    orderBy: { postDate: "asc" },
  });

  if (movimientos.length === 0) {
    console.log("No se encontraron movimientos de $7.000.000 en ese rango para esas cuentas.");
    return;
  }

  for (const m of movimientos) {
    console.log(
      `${m.postDate.toISOString().slice(0, 10)} | ${m.direction} | $${m.amount} | ` +
        `${m.account.bankName} ${m.account.holderName} (${m.account.displayNumber || m.account.accountNumber}) | ` +
        `glosa: "${m.description}" | contraparte: ${m.counterpartyName ?? "—"} / ${m.counterpartyRut ?? "—"}`,
    );
  }
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
