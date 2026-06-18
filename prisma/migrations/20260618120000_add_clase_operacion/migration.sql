-- La API /dynatech ahora manda dos campos: `naturalezaOperacion` (dirección
-- INGRESO/EGRESO) y `tipoOperacion` (clase: TBK / INGRESO / EGRESO /
-- CRYPTOMKT_*). Guardamos la clase para distinguir cripto de un depósito normal.
-- (Los TBK se descartan en el sync; ya vienen por TbkTesoreria.)
ALTER TABLE "TesoreriaMovement" ADD COLUMN "clase_operacion" TEXT;
