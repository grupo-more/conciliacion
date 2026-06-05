-- Campo nuevo de la API /dynatech (jun-2026): tipoOperacion (INGRESO | EGRESO).
-- Discrimina contra que lado de la cartola se concilia cada movimiento de
-- Tesoreria: INGRESO -> BankMovement IN, EGRESO -> BankMovement OUT.

-- AlterTable: agregar columna con default INGRESO (todos los historicos eran
-- ingresos porque la API antes no mandaba egresos).
ALTER TABLE "TesoreriaMovement"
  ADD COLUMN "tipo_operacion" TEXT NOT NULL DEFAULT 'INGRESO';

-- Backfill defensivo: si por algun motivo ya hubiera movimientos con monto
-- negativo cargados (egresos), marcarlos como EGRESO segun el signo.
UPDATE "TesoreriaMovement"
  SET "tipo_operacion" = 'EGRESO'
  WHERE "monto" < 0;

-- CreateIndex
CREATE INDEX "TesoreriaMovement_tipo_operacion_idx"
  ON "TesoreriaMovement"("tipo_operacion");
