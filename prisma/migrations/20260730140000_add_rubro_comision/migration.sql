-- Tab "Diferencias y comisiones" (ex "Dif menor a 100"): rubro destino de las
-- comisiones/cargos bancarios (asiento Debe rubro_comision / Haber rubro banco).

ALTER TABLE "DifMenorSettings" ADD COLUMN "rubro_comision" INTEGER NOT NULL DEFAULT 1503;
