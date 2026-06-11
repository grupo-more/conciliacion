-- Asientos manuales para movimientos de cartola sin contraparte en el sistema.
-- Maestro de sucursales (con headcount para el prorrateo), el asiento + sus
-- líneas por sucursal, y un settings de un row (tasa de retención + rubro 26).

-- Maestro de sucursales (centro de costo). headcount puede ser fraccionado.
CREATE TABLE "Sucursal" (
    "id" TEXT NOT NULL,
    "codigo" INTEGER,
    "nombre" TEXT NOT NULL,
    "headcount" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Sucursal_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Sucursal_codigo_key" ON "Sucursal"("codigo");
CREATE INDEX "Sucursal_active_idx" ON "Sucursal"("active");

-- Asiento manual ligado 1:1 a un BankMovement.
CREATE TABLE "AsientoManual" (
    "id" TEXT NOT NULL,
    "bank_movement_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'GENERADO',
    "monto_neto" BIGINT NOT NULL,
    "retencion_tasa" DECIMAL(7,4),
    "monto_retencion" BIGINT NOT NULL DEFAULT 0,
    "retencion_rubro" INTEGER,
    "monto_bruto" BIGINT NOT NULL,
    "glosa" TEXT,
    "notas" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AsientoManual_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AsientoManual_bank_movement_id_key" ON "AsientoManual"("bank_movement_id");
CREATE INDEX "AsientoManual_tipo_idx" ON "AsientoManual"("tipo");
CREATE INDEX "AsientoManual_estado_idx" ON "AsientoManual"("estado");

-- Líneas del DEBE: una por sucursal, con snapshot de personas/%/monto.
CREATE TABLE "AsientoManualLinea" (
    "id" TEXT NOT NULL,
    "asiento_id" TEXT NOT NULL,
    "sucursal_id" TEXT NOT NULL,
    "sucursal_nombre" TEXT NOT NULL,
    "personas" DECIMAL(6,2) NOT NULL,
    "porcentaje" DECIMAL(7,4) NOT NULL,
    "monto" BIGINT NOT NULL,
    CONSTRAINT "AsientoManualLinea_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AsientoManualLinea_asiento_id_idx" ON "AsientoManualLinea"("asiento_id");
CREATE INDEX "AsientoManualLinea_sucursal_id_idx" ON "AsientoManualLinea"("sucursal_id");

-- Settings de un row: tasa de retención vigente + rubro destino (default 26).
CREATE TABLE "AsientoManualSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "retencion_tasa" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "retencion_rubro" INTEGER NOT NULL DEFAULT 26,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AsientoManualSettings_pkey" PRIMARY KEY ("id")
);

-- FKs
ALTER TABLE "AsientoManual" ADD CONSTRAINT "AsientoManual_bank_movement_id_fkey"
    FOREIGN KEY ("bank_movement_id") REFERENCES "BankMovement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AsientoManualLinea" ADD CONSTRAINT "AsientoManualLinea_asiento_id_fkey"
    FOREIGN KEY ("asiento_id") REFERENCES "AsientoManual"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AsientoManualLinea" ADD CONSTRAINT "AsientoManualLinea_sucursal_id_fkey"
    FOREIGN KEY ("sucursal_id") REFERENCES "Sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed del row default de settings (rubro retención = 26, tasa 0 hasta que se configure).
INSERT INTO "AsientoManualSettings" ("id", "retencion_tasa", "retencion_rubro", "updated_at")
VALUES ('default', 0, 26, NOW());
