-- Movimientos descartados: movimientos de cartola que no corresponden al
-- sistema. Se marcan (no se borran) y se registran de forma durable por
-- (cuenta, dedup_key) para que el re-import no los reinserte.

-- AlterTable: marca de descarte en el movimiento (soft-delete)
ALTER TABLE "BankMovement" ADD COLUMN "descartado_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BankMovement_descartado_at_idx" ON "BankMovement"("descartado_at");

-- CreateTable: registro durable del descarte
CREATE TABLE "MovimientoDescartado" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "razon" TEXT,
    "descartado_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovimientoDescartado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MovimientoDescartado_account_id_dedup_key_key" ON "MovimientoDescartado"("account_id", "dedup_key");
CREATE INDEX "MovimientoDescartado_account_id_idx" ON "MovimientoDescartado"("account_id");

-- AddForeignKey
ALTER TABLE "MovimientoDescartado" ADD CONSTRAINT "MovimientoDescartado_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
