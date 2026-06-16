-- Vínculo manual POS↔settlement en Cruce Transbank (para pares sin llave común
-- o que el motor no cuadra solo). El matching los fuerza como cuadrados.
CREATE TABLE "CruceTransbankLink" (
    "id" TEXT NOT NULL,
    "tbk_tesoreria_id" TEXT NOT NULL,
    "transbank_sale_id" TEXT NOT NULL,
    "nota" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CruceTransbankLink_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CruceTransbankLink_tbk_tesoreria_id_key" ON "CruceTransbankLink"("tbk_tesoreria_id");
CREATE UNIQUE INDEX "CruceTransbankLink_transbank_sale_id_key" ON "CruceTransbankLink"("transbank_sale_id");
CREATE INDEX "CruceTransbankLink_created_at_idx" ON "CruceTransbankLink"("created_at");
