-- AlterTable
ALTER TABLE "DynatechMovement" ADD COLUMN     "rubro" INTEGER;

-- CreateIndex
CREATE INDEX "DynatechMovement_rubro_idx" ON "DynatechMovement"("rubro");
