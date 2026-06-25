-- POS ficticio en Cruce Transbank: movimiento insertado a mano (no viene de la
-- API) para poder vincular un abono Transbank sin POS (venta parte tarjeta +
-- parte efectivo que la API no registró). externalId queda negativo, así el sync
-- (upsert por externalId positivo) nunca lo pisa. `manual` permite badgearlo y
-- excluirlo de los totales de ventas POS reales.
ALTER TABLE "TbkTesoreria" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TbkTesoreria" ADD COLUMN "manual_nota" TEXT;
ALTER TABLE "TbkTesoreria" ADD COLUMN "created_by_id" TEXT;
