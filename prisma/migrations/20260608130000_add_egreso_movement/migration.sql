-- Gastos operativos (feed /api/egresos). Aislado del motor de consolidados.
CREATE TABLE "EgresoMovement" (
    "id" TEXT NOT NULL,
    "external_id" BIGINT NOT NULL,
    "sucursal_id" INTEGER NOT NULL,
    "sucursal_name" TEXT,
    "cajero_username" TEXT,
    "cajero_name" TEXT,
    "glosa" TEXT NOT NULL,
    "monto" BIGINT NOT NULL,
    "rubro_id" INTEGER,
    "rubro_nombre" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "fecha_carga" TIMESTAMP(3),
    "raw_json" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EgresoMovement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EgresoMovement_external_id_key" ON "EgresoMovement"("external_id");
CREATE INDEX "EgresoMovement_sucursal_id_fecha_idx" ON "EgresoMovement"("sucursal_id", "fecha");
CREATE INDEX "EgresoMovement_rubro_id_idx" ON "EgresoMovement"("rubro_id");
CREATE INDEX "EgresoMovement_fecha_idx" ON "EgresoMovement"("fecha");
