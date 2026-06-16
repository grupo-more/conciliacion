-- La API tbk-tesoreria trae ahora la comisión por operación (objeto `comision`,
-- monto CON IVA = comisión registrada en Dynatech). La guardamos en TbkTesoreria
-- y la usamos como rubro 708 en la cuadratura; el 1403 pasa a ser la diferencia
-- contra la comisión de cartola.

-- Comisión del feed en TbkTesoreria.
ALTER TABLE "TbkTesoreria" ADD COLUMN "comision_monto" BIGINT;
ALTER TABLE "TbkTesoreria" ADD COLUMN "comision_porcentaje" DECIMAL(7,4);
ALTER TABLE "TbkTesoreria" ADD COLUMN "comision_id" BIGINT;
ALTER TABLE "TbkTesoreria" ADD COLUMN "comision_glosa" TEXT;
ALTER TABLE "TbkTesoreria" ADD COLUMN "comision_fecha" TIMESTAMP(3);

-- Comisión Dynatech (→ 708) en el item de cuadratura. La existente
-- "monto_comision" pasa a representar la comisión de cartola (→ 1403).
ALTER TABLE "CuadraturaTransbankItem" ADD COLUMN "monto_comision_api" BIGINT NOT NULL DEFAULT 0;
