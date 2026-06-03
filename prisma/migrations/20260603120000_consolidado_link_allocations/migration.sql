-- Habilita el "split inverso": 1 BankMovement puede vincularse a N Consolidados,
-- cada uno consumiendo una porción de su monto. Útil cuando una transferencia
-- bancaria única se registró en Tesorería como N movimientos separados (mismo
-- cliente, mismo día, montos parciales).
--
-- amount_allocated NULL  → allocation completa (caso histórico 1:1 / N:1).
-- amount_allocated > 0  → porción específica del BankMovement consumida por
--                          este Consolidado. La suma de allocations de un BM
--                          no puede exceder su amount (validado en código).

-- Drop del unique sobre bank_movement_id: ya no se sostiene cuando un BM se
-- reparte entre múltiples Consolidados.
DROP INDEX IF EXISTS "ConsolidadoLink_bank_movement_id_key";

-- Index normal para mantener performance en lookups por bank_movement_id
-- (ej. detectar links existentes en manual-link).
CREATE INDEX IF NOT EXISTS "ConsolidadoLink_bank_movement_id_idx" ON "ConsolidadoLink"("bank_movement_id");

-- Columna de porción asignada. Nullable para no romper datos históricos.
ALTER TABLE "ConsolidadoLink" ADD COLUMN IF NOT EXISTS "amount_allocated" BIGINT;
