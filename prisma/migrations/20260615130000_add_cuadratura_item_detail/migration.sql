-- Detalle por movimiento en el item de cuadratura, para el desglose auditable
-- (qué pares POS↔settlement componen el total de cada sucursal). Nullable para
-- no romper filas existentes.
ALTER TABLE "CuadraturaTransbankItem" ADD COLUMN "fecha" TIMESTAMP(3);
ALTER TABLE "CuadraturaTransbankItem" ADD COLUMN "op_boleta" TEXT;
ALTER TABLE "CuadraturaTransbankItem" ADD COLUMN "medio_pago" TEXT;
