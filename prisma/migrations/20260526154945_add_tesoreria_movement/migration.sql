-- CreateTable
CREATE TABLE "TesoreriaMovement" (
    "id" TEXT NOT NULL,
    "external_id" BIGINT NOT NULL,
    "sucursal_id" INTEGER NOT NULL,
    "sucursal_name" TEXT,
    "cajero_username" TEXT NOT NULL,
    "cajero_name" TEXT,
    "cliente_name" TEXT,
    "cliente_rut" TEXT,
    "folio" BIGINT NOT NULL DEFAULT 0,
    "tipo_documento" TEXT,
    "codigo_documento" INTEGER NOT NULL DEFAULT 0,
    "glosa" TEXT NOT NULL,
    "banco" TEXT,
    "banco_sucursal" TEXT,
    "banco_detectado" TEXT,
    "rubro_banco" INTEGER,
    "rubro_sucursal" INTEGER,
    "monto" BIGINT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "fecha_carga" TIMESTAMP(3),
    "es_excepcion" BOOLEAN NOT NULL DEFAULT false,
    "items" JSONB NOT NULL,
    "raw_json" JSONB NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesoreriaMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesoreriaSyncRun" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "fetched_rows" INTEGER NOT NULL DEFAULT 0,
    "inserted_rows" INTEGER NOT NULL DEFAULT 0,
    "updated_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_duplicates" INTEGER NOT NULL DEFAULT 0,
    "skipped_invalid" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "fetch_ms" INTEGER,

    CONSTRAINT "TesoreriaSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TesoreriaMovement_external_id_key" ON "TesoreriaMovement"("external_id");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_sucursal_id_idx" ON "TesoreriaMovement"("sucursal_id");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_cajero_username_idx" ON "TesoreriaMovement"("cajero_username");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_fecha_idx" ON "TesoreriaMovement"("fecha");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_banco_idx" ON "TesoreriaMovement"("banco");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_rubro_banco_idx" ON "TesoreriaMovement"("rubro_banco");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_rubro_sucursal_idx" ON "TesoreriaMovement"("rubro_sucursal");

-- CreateIndex
CREATE INDEX "TesoreriaMovement_es_excepcion_idx" ON "TesoreriaMovement"("es_excepcion");

-- CreateIndex
CREATE INDEX "TesoreriaSyncRun_started_at_idx" ON "TesoreriaSyncRun"("started_at");

-- CreateIndex
CREATE INDEX "TesoreriaSyncRun_status_started_at_idx" ON "TesoreriaSyncRun"("status", "started_at");
