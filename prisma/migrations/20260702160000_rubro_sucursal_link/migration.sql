-- Enlace explícito sucursal → rubro contable (Configuración → Rubros).
-- Se usa para poner el rubro de la sucursal en los asientos (Cuadratura
-- consolidación, Asientos manuales proveedor/cliente) en vez del código POS.

ALTER TABLE "RubroLabel" ADD COLUMN "sucursal_id" TEXT;

CREATE UNIQUE INDEX "RubroLabel_sucursal_id_key" ON "RubroLabel"("sucursal_id");

ALTER TABLE "RubroLabel" ADD CONSTRAINT "RubroLabel_sucursal_id_fkey"
  FOREIGN KEY ("sucursal_id") REFERENCES "Sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
