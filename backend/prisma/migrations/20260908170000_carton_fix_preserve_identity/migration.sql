-- CARTON FIX: preserve carton identity end-to-end (suivi_code, tracking_code, QR, barcode, entity_type=CARTON, originalPayload, metadata, sourceProject, productCount, cartonId relation)
-- This migration makes the DB match schema.prisma after the carton fix.

-- expected_arrival_items: cartonId relation + originalPayload
ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "cartonId" TEXT;
ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "originalPayload" JSONB;

-- warehouse_cartons: explicit identity preservation
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "suiviCode" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "trackingCode" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "entityType" TEXT NOT NULL DEFAULT 'CARTON';
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "originalPayload" JSONB;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "sourceProject" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "productCount" INTEGER DEFAULT 0;

-- warehouse_shipments: suivi + originalPayload + metadata + sourceProject
ALTER TABLE "warehouse_shipments" ADD COLUMN IF NOT EXISTS "suiviCode" TEXT;
ALTER TABLE "warehouse_shipments" ADD COLUMN IF NOT EXISTS "originalPayload" JSONB;
ALTER TABLE "warehouse_shipments" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "warehouse_shipments" ADD COLUMN IF NOT EXISTS "sourceProject" TEXT;

-- Indexes (if not exists)
CREATE INDEX IF NOT EXISTS "expected_arrival_items_cartonId_idx" ON "expected_arrival_items"("cartonId");
CREATE INDEX IF NOT EXISTS "warehouse_cartons_suiviCode_idx" ON "warehouse_cartons"("suiviCode");
CREATE INDEX IF NOT EXISTS "warehouse_cartons_trackingCode_idx" ON "warehouse_cartons"("trackingCode");
CREATE INDEX IF NOT EXISTS "warehouse_cartons_entityType_idx" ON "warehouse_cartons"("entityType");
CREATE INDEX IF NOT EXISTS "warehouse_shipments_suiviCode_idx" ON "warehouse_shipments"("suiviCode");

-- Foreign key for expected_arrival_items.cartonId -> warehouse_cartons.id (if not exists, try add constraint)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'expected_arrival_items_cartonId_fkey' 
    AND table_name = 'expected_arrival_items'
  ) THEN
    ALTER TABLE "expected_arrival_items" ADD CONSTRAINT "expected_arrival_items_cartonId_fkey" 
      FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
