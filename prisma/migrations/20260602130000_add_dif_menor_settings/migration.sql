-- Modulo "Dif menor a 100": tabla con un unico row para guardar el umbral
-- configurable (default 100) y el rubro de diferencia destino (default 2050).
-- El admin puede editar ambos desde Configuracion.

CREATE TABLE "DifMenorSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "threshold" INTEGER NOT NULL DEFAULT 100,
    "rubro_diferencia" INTEGER NOT NULL DEFAULT 2050,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DifMenorSettings_pkey" PRIMARY KEY ("id")
);

-- Seed del unico row default
INSERT INTO "DifMenorSettings" ("id", "threshold", "rubro_diferencia", "updated_at")
VALUES ('default', 100, 2050, NOW());
