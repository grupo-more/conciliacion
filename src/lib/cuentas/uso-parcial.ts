/**
 * Cuentas de "uso parcial": solo sus traspasos internos son relevantes (viven
 * en Consolidados → Traspasos internos). TODO el resto de sus movimientos NO
 * cuenta como "sin conciliar" en ninguna vista (Cartolas, Consolidados,
 * Reportes) — se consideran "No relevante / fuera de scope".
 *
 * Historial:
 *  - 2026-06-09: MORE CAPITAL – Banco Internacional (9822911) marcada como uso
 *    parcial (la cuenta estaba inhabilitada / no se usaba).
 *  - 2026-07-02: se REACTIVA esa cuenta (ahora sí se usa) → lista vacía. Sus
 *    movimientos pasan a conciliarse normal (aparecen en las tabs y cuentan como
 *    "sin conciliar" hasta cuadrarse). Para volver a inhabilitarla, re-agregar
 *    la entrada. Para hacerlo configurable, migrar a un flag en BankAccount.
 */
import type { Prisma } from "@prisma/client";

interface AccountIdent {
  bankCode: string; // "BCI" | "SANTANDER" | "INTERNACIONAL"
  accountNumber: string; // número (solo dígitos)
}

const USO_PARCIAL: AccountIdent[] = [
  // { bankCode: "INTERNACIONAL", accountNumber: "9822911" }, // reactivada 2026-07-02
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

/**
 * Where Prisma para "la cuenta ES de uso parcial" (filtro sobre BankAccount).
 * Con la lista vacía, se usa un filtro que NO matchea ninguna cuenta (para que
 * `isNot: usoParcialAccountWhere` incluya a todas).
 */
export const usoParcialAccountWhere: Prisma.BankAccountWhereInput =
  USO_PARCIAL.length === 0
    ? { id: { in: [] } } // matchea nada
    : {
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

/**
 * Fragmento SQL: condición de "uso parcial" sobre un alias de BankAccount `ba`.
 * Con la lista vacía devuelve "FALSE" (así `NOT (FALSE)` = TRUE y no rompe la SQL).
 */
export const USO_PARCIAL_SQL =
  USO_PARCIAL.length === 0
    ? "FALSE"
    : USO_PARCIAL.map(
        (u) =>
          `(ba.bank_code = '${u.bankCode}' AND (ba.account_number = '${u.accountNumber}' OR ba.display_number = '${u.accountNumber}'))`,
      ).join(" OR ");
