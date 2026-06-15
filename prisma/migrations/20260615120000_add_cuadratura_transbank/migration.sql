-- Cuadratura Transbank: asiento de cuadratura POS(Dynatech) vs settlement
-- Transbank por sucursal (subtab "Conciliados (asiento)" de Cruce Transbank).
-- Persiste los pares consumidos para no re-considerarlos en la próxima corrida.

-- CreateTable: cabecera de una cuadratura generada.
CREATE TABLE "CuadraturaTransbank" (
    "id" TEXT NOT NULL,
    "desde" TIMESTAMP(3) NOT NULL,
    "hasta" TIMESTAMP(3) NOT NULL,
    "glosa" TEXT,
    "rubro_ventas" INTEGER NOT NULL,
    "rubro_tesoreria" INTEGER NOT NULL,
    "rubro_comision" INTEGER NOT NULL,
    "rubro_diferencia" INTEGER NOT NULL,
    "total_dynatech" BIGINT NOT NULL DEFAULT 0,
    "total_transbank" BIGINT NOT NULL DEFAULT 0,
    "total_comision" BIGINT NOT NULL DEFAULT 0,
    "total_diferencia" BIGINT NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CuadraturaTransbank_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CuadraturaTransbank_created_at_idx" ON "CuadraturaTransbank"("created_at");

-- CreateTable: par POS↔settlement consumido. Unicidad de cada lado = no repetir.
CREATE TABLE "CuadraturaTransbankItem" (
    "id" TEXT NOT NULL,
    "cuadratura_id" TEXT NOT NULL,
    "tbk_tesoreria_id" TEXT NOT NULL,
    "transbank_sale_id" TEXT NOT NULL,
    "sucursal_id" INTEGER NOT NULL,
    "sucursal_name" TEXT,
    "sucursal_codigo" INTEGER,
    "monto_dynatech" BIGINT NOT NULL,
    "monto_transbank" BIGINT NOT NULL,
    "monto_comision" BIGINT NOT NULL,
    CONSTRAINT "CuadraturaTransbankItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CuadraturaTransbankItem_tbk_tesoreria_id_key" ON "CuadraturaTransbankItem"("tbk_tesoreria_id");
CREATE UNIQUE INDEX "CuadraturaTransbankItem_transbank_sale_id_key" ON "CuadraturaTransbankItem"("transbank_sale_id");
CREATE INDEX "CuadraturaTransbankItem_cuadratura_id_idx" ON "CuadraturaTransbankItem"("cuadratura_id");
CREATE INDEX "CuadraturaTransbankItem_sucursal_id_idx" ON "CuadraturaTransbankItem"("sucursal_id");

ALTER TABLE "CuadraturaTransbankItem" ADD CONSTRAINT "CuadraturaTransbankItem_cuadratura_id_fkey"
    FOREIGN KEY ("cuadratura_id") REFERENCES "CuadraturaTransbank"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: settings de un row con los 4 rubros del asiento.
CREATE TABLE "CuadraturaTransbankSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "rubro_ventas" INTEGER NOT NULL DEFAULT 17,
    "rubro_tesoreria" INTEGER NOT NULL DEFAULT 200,
    "rubro_comision" INTEGER NOT NULL DEFAULT 708,
    "rubro_diferencia" INTEGER NOT NULL DEFAULT 1403,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CuadraturaTransbankSettings_pkey" PRIMARY KEY ("id")
);

-- Seed del row default (rubros 17 / 200 / 708 / 1403).
INSERT INTO "CuadraturaTransbankSettings"
    ("id", "rubro_ventas", "rubro_tesoreria", "rubro_comision", "rubro_diferencia", "updated_at")
VALUES ('default', 17, 200, 708, 1403, NOW());
