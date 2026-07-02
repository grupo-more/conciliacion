-- Enlace explícito cuenta bancaria → rubro contable (Configuración → Rubros).
-- Se usa para resolver el rubro del banco en los asientos (Asientos manuales /
-- Traspasos internos) sin adivinar por nombre. Una cuenta → un rubro (único).

ALTER TABLE "RubroLabel" ADD COLUMN "account_id" TEXT;

CREATE UNIQUE INDEX "RubroLabel_account_id_key" ON "RubroLabel"("account_id");

ALTER TABLE "RubroLabel" ADD CONSTRAINT "RubroLabel_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
