-- "Abonos conciliados" (Cruce Transbank): abonos/cargos de Transbank ajenos a
-- la operación de la empresa (nunca tendrán POS). Se identifican a mano y se
-- contabilizan directo Debe/Haber contra rubros configurables (neto).

-- AlterTable: marca reversible en el settlement
ALTER TABLE "TransbankSale" ADD COLUMN "abono_conciliado_at" TIMESTAMP(3);
ALTER TABLE "TransbankSale" ADD COLUMN "abono_conciliado_by_id" TEXT;

-- CreateIndex
CREATE INDEX "TransbankSale_abono_conciliado_at_idx" ON "TransbankSale"("abono_conciliado_at");

-- CreateTable: rubros del asiento (1 row, editable en Configuración)
CREATE TABLE "AbonoConciliadoSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "rubro_debe" INTEGER NOT NULL DEFAULT 200,
    "rubro_haber" INTEGER NOT NULL DEFAULT 1403,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AbonoConciliadoSettings_pkey" PRIMARY KEY ("id")
);

-- Seed del unico row default
INSERT INTO "AbonoConciliadoSettings" ("id", "rubro_debe", "rubro_haber", "updated_at")
VALUES ('default', 200, 1403, NOW());
