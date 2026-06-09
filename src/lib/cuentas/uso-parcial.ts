/**
 * Cuentas de "uso parcial": solo sus traspasos internos son relevantes (viven
 * en Consolidados → Traspasos internos). TODO el resto de sus movimientos NO
 * cuenta como "sin conciliar" en ninguna vista (Cartolas, Consolidados,
 * Reportes) — se consideran "No relevante / fuera de scope".
 *
 * Decisión actual (2026-06-09): una sola cuenta, MORE CAPITAL – Banco
 * Internacional (9822911). Se centraliza acá para que cambiarla/extenderla no
 * requiera tocar las múltiples vistas que la consultan. Para hacerlo
 * configurable a futuro, migrar esta lista a un flag en BankAccount.
 */
import type { Prisma } from "@prisma/client";

interface AccountIdent {
  bankCode: string; // "BCI" | "SANTANDER" | "INTERNACIONAL"
  accountNumber: string; // número (solo dígitos)
}

const USO_PARCIAL: AccountIdent[] = [
  { bankCode: "INTERNACIONAL", accountNumber: "9822911" },
];

function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Predicado JS: la cuenta es de uso parcial. */
export function isUsoParcialAccount(acc: {
  bankCode?: string | null;
  accountNumber?: string | null;
  displayNumber?: string | null;
}): boolean {
  const code = (acc.bankCode ?? "").toUpperCase();
  return USO_PARCIAL.some(
    (u) =>
      code === u.bankCode &&
      (digits(acc.accountNumber) === u.accountNumber ||
        digits(acc.displayNumber) === u.accountNumber),
  );
}

/** Where Prisma para "la cuenta ES de uso parcial" (filtro sobre BankAccount). */
export const usoParcialAccountWhere: Prisma.BankAccountWhereInput = {
  OR: USO_PARCIAL.map((u) => ({
    AND: [
      { bankCode: u.bankCode },
      {
        OR: [
          { accountNumber: u.accountNumber },
          { displayNumber: u.accountNumber },
        ],
      },
    ],
  })),
};

/** Fragmento SQL: condición de "uso parcial" sobre un alias de BankAccount `ba`. */
export const USO_PARCIAL_SQL = USO_PARCIAL.map(
  (u) =>
    `(ba.bank_code = '${u.bankCode}' AND (ba.account_number = '${u.accountNumber}' OR ba.display_number = '${u.accountNumber}'))`,
).join(" OR ");
