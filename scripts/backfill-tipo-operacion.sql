-- Backfill de una sola vez: marca como EGRESO los movimientos de Tesoreria
-- que ya estaban cargados con monto negativo (la columna tipo_operacion se
-- crea con default 'INGRESO', y `prisma db push` no corre el backfill de la
-- migracion). Correr en el servidor despues del deploy.
--
--   npx prisma db execute --schema prisma/schema.prisma --file scripts/backfill-tipo-operacion.sql
--
-- Idempotente: se puede correr varias veces sin efecto adverso.
UPDATE "TesoreriaMovement"
  SET "tipo_operacion" = 'EGRESO'
  WHERE "monto" < 0 AND "tipo_operacion" <> 'EGRESO';
