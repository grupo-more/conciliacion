-- Modulo "Egresos internos": entidades cuyo RUT/nombre identifica un egreso
-- bancario como transferencia a una cuenta propia (no a un tercero).
-- Cada entidad guarda RUT canonico + nombre canonico + lista de aliases
-- observados en las cartolas (campo counterpartyName cuando viene sin RUT).

CREATE TABLE "EntidadInterna" (
    "id" TEXT NOT NULL,
    "rut_canonico" TEXT NOT NULL,
    "nombre_canonico" TEXT NOT NULL,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rubro" INTEGER,
    "notas" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EntidadInterna_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntidadInterna_rut_canonico_key" ON "EntidadInterna"("rut_canonico");
CREATE INDEX "EntidadInterna_active_idx" ON "EntidadInterna"("active");

ALTER TABLE "EntidadInterna"
    ADD CONSTRAINT "EntidadInterna_rubro_fkey"
    FOREIGN KEY ("rubro") REFERENCES "RubroLabel"("rubro")
    ON DELETE SET NULL ON UPDATE CASCADE;
