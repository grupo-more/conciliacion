-- Papelera de la cuadratura: pares cuadrados apartados para que no entren al
-- asiento. expires_at = ventana para restaurar (red de seguridad ante error);
-- pasado el plazo el apartado es definitivo. La exclusión la da la existencia
-- del row (no hay job de expiración).
CREATE TABLE "CuadraturaTransbankApartado" (
    "id" TEXT NOT NULL,
    "tbk_tesoreria_id" TEXT NOT NULL,
    "transbank_sale_id" TEXT NOT NULL,
    "sucursal_id" INTEGER NOT NULL,
    "sucursal_name" TEXT,
    "sucursal_codigo" INTEGER,
    "fecha" TIMESTAMP(3),
    "op_boleta" TEXT,
    "medio_pago" TEXT,
    "monto_dynatech" BIGINT NOT NULL,
    "monto_transbank" BIGINT NOT NULL,
    "monto_comision" BIGINT NOT NULL,
    "motivo" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CuadraturaTransbankApartado_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CuadraturaTransbankApartado_tbk_tesoreria_id_key" ON "CuadraturaTransbankApartado"("tbk_tesoreria_id");
CREATE UNIQUE INDEX "CuadraturaTransbankApartado_transbank_sale_id_key" ON "CuadraturaTransbankApartado"("transbank_sale_id");
CREATE INDEX "CuadraturaTransbankApartado_expires_at_idx" ON "CuadraturaTransbankApartado"("expires_at");
