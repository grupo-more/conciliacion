-- Movimiento bancario manual/ficticio (definido a mano para cuadrar una
-- Tesorería que la cartola no capturó). Excluido de saldos/listados de cartola.
ALTER TABLE "bank_movements" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bank_movements" ADD COLUMN "manual_nota" TEXT;
