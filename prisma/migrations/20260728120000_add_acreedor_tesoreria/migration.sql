-- Cola manual "Acreedores tesorería": tesorerías EGRESO que el operador deriva
-- a mano (no son identificables automáticamente) para cuadrarlas contra cartola
-- en su propia tab. Marca reversible; marcado != resuelto.

-- AlterTable
ALTER TABLE "TesoreriaMovement" ADD COLUMN "acreedor_tesoreria_at" TIMESTAMP(3);
ALTER TABLE "TesoreriaMovement" ADD COLUMN "acreedor_tesoreria_by_id" TEXT;

-- CreateIndex
CREATE INDEX "TesoreriaMovement_acreedor_tesoreria_at_idx" ON "TesoreriaMovement"("acreedor_tesoreria_at");
