/**
 * Crea la cuenta bancaria FICTICIA usada para marcar Tesorerías ya conciliadas
 * fuera del sistema (botón "Crear movimiento bancario manual" en Comparar
 * Ingresos/Comparar Egresos). No es un banco real — solo existe para elegirla
 * como "Cuenta bancaria" en ese modal cuando la Tesorería ya se resolvió a
 * mano afuera, y así deja de aparecer pendiente.
 *
 * Uso (EN EL SERVER, con DATABASE_URL real):
 *   npx tsx scripts/crear-cuenta-conciliado-externo.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const BANK_CODE = "MANUAL";
const ACCOUNT_NUMBER = "MANUAL-001";

async function main() {
  const existing = await prisma.bankAccount.findUnique({
    where: { bankCode_accountNumber: { bankCode: BANK_CODE, accountNumber: ACCOUNT_NUMBER } },
  });
  if (existing) {
    console.log(`Ya existe: ${existing.id} — ${existing.bankName} · ${existing.holderName}`);
    return;
  }

  const created = await prisma.bankAccount.create({
    data: {
      bankCode: BANK_CODE,
      bankName: "Conciliado externo",
      accountNumber: ACCOUNT_NUMBER,
      displayNumber: null,
      holderName: "Conciliado externo (fuera de sistema)",
      currency: "CLP",
      purpose:
        "Cuenta ficticia para marcar Tesorerías ya conciliadas fuera del sistema " +
        "(Comparar Ingresos/Egresos -> Crear movimiento bancario manual). " +
        "No corresponde a un banco real: no importar cartolas acá.",
    },
  });

  console.log(`Creada: ${created.id} — ${created.bankName} · ${created.holderName}`);
  console.log('Ya deberías verla en el dropdown "Cuenta bancaria" del modal de Comparar Ingresos/Egresos.');
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
