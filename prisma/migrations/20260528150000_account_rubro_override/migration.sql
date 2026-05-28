-- Rubro contable "natural" de cada cuenta bancaria. Se configura desde la UI
-- y se usa en el asiento OK cuando el match es MANUAL.
ALTER TABLE "BankAccount" ADD COLUMN "accounting_rubro" INTEGER;

-- Override del rubro banco para un Consolidado puntual (solo MANUAL).
ALTER TABLE "Consolidado" ADD COLUMN "override_rubro_banco" INTEGER;
