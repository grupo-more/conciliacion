-- Estado de anulacion del documento en origen (contexto.estado de la API,
-- jun-2026). CAJ = cajeado (valido), ANU = anulado. `anulado`=true marca la
-- transicion CAJ->ANU (se anulo despues de existir como valido). Los anulados
-- (estado_actual='ANU') se excluyen del motor de Consolidados y de las vistas
-- de "sin conciliar".
--
-- Backfill: NO se rellenan los historicos. El raw_json guardado es la fila YA
-- parseada por Zod, que hasta ahora descartaba `estado`, asi que el dato no
-- existe en filas viejas. Las columnas quedan NULL/false (= tratadas como
-- validas) y la siguiente sincronizacion (upsert completo de cada fila) las
-- repuebla para todos los movimientos vigentes.

-- AlterTable: TesoreriaMovement (feed /api/dynatech)
ALTER TABLE "TesoreriaMovement"
  ADD COLUMN "estado_original" TEXT,
  ADD COLUMN "estado_actual"   TEXT,
  ADD COLUMN "anulado"         BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "TesoreriaMovement_estado_actual_idx"
  ON "TesoreriaMovement"("estado_actual");

-- AlterTable: TbkTesoreria (feed /api/tbk-tesoreria)
ALTER TABLE "TbkTesoreria"
  ADD COLUMN "estado_original" TEXT,
  ADD COLUMN "estado_actual"   TEXT,
  ADD COLUMN "anulado"         BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "TbkTesoreria_estado_actual_idx"
  ON "TbkTesoreria"("estado_actual");
