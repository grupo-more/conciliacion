-- Flag para marcar qué rubros se pueden usar como destino de la diferencia
-- en matches manuales con ajuste. Default false: los rubros existentes no
-- cambian su comportamiento.
ALTER TABLE "RubroLabel" ADD COLUMN "is_difference" BOOLEAN NOT NULL DEFAULT false;

-- Ajuste por diferencia entre el monto bancario y el de Tesorería.
-- Se llena solo cuando el operador cierra un MANUAL con diferencia.
ALTER TABLE "Consolidado" ADD COLUMN "adjustment_amount" BIGINT;
ALTER TABLE "Consolidado" ADD COLUMN "adjustment_rubro" INTEGER;
ALTER TABLE "Consolidado" ADD COLUMN "adjustment_note" TEXT;
