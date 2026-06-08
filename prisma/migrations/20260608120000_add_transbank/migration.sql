-- Transbank: dos fuentes nuevas que se cuadran entre si en "Cruce Transbank".
-- Ninguna entra al motor de Consolidados (viven aparte para no generar ruido).

-- CreateTable: import del archivo .xls "Abonos por dia"
CREATE TABLE "TransbankImport" (
    "id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "empresa_rut" TEXT,
    "cuenta_abono" TEXT,
    "period_from" TIMESTAMP(3),
    "period_to" TIMESTAMP(3),
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_duplicated" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransbankImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransbankImport_file_hash_key" ON "TransbankImport"("file_hash");
CREATE INDEX "TransbankImport_created_at_idx" ON "TransbankImport"("created_at");

-- CreateTable: venta liquidada por Transbank (lado abono/banco)
CREATE TABLE "TransbankSale" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "fecha_venta" TIMESTAMP(3) NOT NULL,
    "tipo_movimiento" TEXT NOT NULL,
    "codigo_comercio" TEXT NOT NULL,
    "nombre_local" TEXT NOT NULL,
    "sucursal_id" INTEGER,
    "medio_pago" TEXT NOT NULL,
    "monto_venta" BIGINT NOT NULL,
    "comision" BIGINT NOT NULL DEFAULT 0,
    "iva_comision" BIGINT NOT NULL DEFAULT 0,
    "total_abono" BIGINT NOT NULL,
    "fecha_anulacion" TIMESTAMP(3),
    "monto_anulado" BIGINT NOT NULL DEFAULT 0,
    "numero_unico" TEXT NOT NULL,
    "tid" TEXT,
    "codigo_autorizacion" TEXT,
    "numero_boleta" TEXT,
    "raw_row" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransbankSale_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransbankSale_numero_unico_key" ON "TransbankSale"("numero_unico");
CREATE INDEX "TransbankSale_sucursal_id_fecha_venta_idx" ON "TransbankSale"("sucursal_id", "fecha_venta");
CREATE INDEX "TransbankSale_numero_boleta_idx" ON "TransbankSale"("numero_boleta");
CREATE INDEX "TransbankSale_monto_venta_idx" ON "TransbankSale"("monto_venta");

ALTER TABLE "TransbankSale"
  ADD CONSTRAINT "TransbankSale_import_id_fkey"
  FOREIGN KEY ("import_id") REFERENCES "TransbankImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: registro POS de venta TBK (feed /api/tbk-tesoreria)
CREATE TABLE "TbkTesoreria" (
    "id" TEXT NOT NULL,
    "external_id" BIGINT NOT NULL,
    "sucursal_id" INTEGER NOT NULL,
    "sucursal_name" TEXT,
    "cajero_username" TEXT,
    "cajero_name" TEXT,
    "glosa" TEXT NOT NULL,
    "op_number" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "monto" BIGINT NOT NULL,
    "folio" BIGINT NOT NULL DEFAULT 0,
    "rubro" INTEGER,
    "tipo" TEXT NOT NULL DEFAULT 'TBK',
    "cliente_name" TEXT,
    "cliente_rut" TEXT,
    "fecha_carga" TIMESTAMP(3),
    "raw_json" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TbkTesoreria_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TbkTesoreria_external_id_key" ON "TbkTesoreria"("external_id");
CREATE INDEX "TbkTesoreria_sucursal_id_fecha_idx" ON "TbkTesoreria"("sucursal_id", "fecha");
CREATE INDEX "TbkTesoreria_op_number_idx" ON "TbkTesoreria"("op_number");
CREATE INDEX "TbkTesoreria_monto_idx" ON "TbkTesoreria"("monto");
