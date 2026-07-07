-- Perfiles de uso del sistema (variables de permisos por perfil).
-- Se siembran los 3 perfiles base y los usuarios existentes quedan como Admin
-- (hoy el único usuario es Gerencia), así el deploy es atómico y nadie pierde
-- acceso. Los usuarios nuevos sin perfil se tratan como "Solo lectura".

CREATE TABLE "Perfil" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "es_admin" BOOLEAN NOT NULL DEFAULT false,
    "permisos" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Perfil_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Perfil_nombre_key" ON "Perfil"("nombre");

ALTER TABLE "User" ADD COLUMN "perfil_id" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_perfil_id_fkey"
  FOREIGN KEY ("perfil_id") REFERENCES "Perfil"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Perfil" ("id", "nombre", "es_admin", "permisos", "updated_at") VALUES
(
  'perfil-admin', 'Admin', true,
  '{"modulos":{"dashboard":true,"consolidados":true,"cartolas":true,"movimientos":true,"reportes":true},"acciones":{"conciliar":true,"reevaluar":true,"generarAsientos":true,"importar":true,"depurar":true,"configurar":true,"gestionarUsuarios":true}}',
  CURRENT_TIMESTAMP
),
(
  'perfil-operador', 'Operador conciliación', false,
  '{"modulos":{"dashboard":true,"consolidados":true,"cartolas":true,"movimientos":true,"reportes":true},"acciones":{"conciliar":true,"reevaluar":true,"generarAsientos":true,"importar":true,"depurar":true,"configurar":false,"gestionarUsuarios":false}}',
  CURRENT_TIMESTAMP
),
(
  'perfil-lectura', 'Solo lectura', false,
  '{"modulos":{"dashboard":true,"consolidados":true,"cartolas":true,"movimientos":true,"reportes":true},"acciones":{"conciliar":false,"reevaluar":false,"generarAsientos":false,"importar":false,"depurar":false,"configurar":false,"gestionarUsuarios":false}}',
  CURRENT_TIMESTAMP
);

-- Usuarios existentes (Gerencia) → Admin.
UPDATE "User" SET "perfil_id" = 'perfil-admin' WHERE "perfil_id" IS NULL;
