-- Quitamos accounting_rubro de BankAccount. La idea de "rubro fijo por cuenta"
-- no aplica al flujo real: el operador a veces se equivoca tipeando el banco
-- al cargar, pero es algo puntual — no un atributo permanente de la cuenta.
-- La corrección se hace por movimiento (Consolidado.override_rubro_banco)
-- desde el panel de match manual en Comparar.
ALTER TABLE "BankAccount" DROP COLUMN IF EXISTS "accounting_rubro";
