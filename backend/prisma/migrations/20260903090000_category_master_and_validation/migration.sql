-- CATEGORY MASTER + VALIDATION + CONFIGURABLE SORTING MAPPING
-- Additive-only. Existing contracts, idempotency keys and workflows are
-- untouched. Guarded so it is safe on databases already repaired out-of-band
-- by the in-process bootstrap repair.

-- Enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "CategoryValidationStatus" AS ENUM ('CONFIRMED', 'NEEDS_REVIEW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audit actions (classification traceability) --------------------------------
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MAPPING_SET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MAPPING_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_VALIDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_NEEDS_REVIEW';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MANUALLY_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SORTING_DESTINATION_SELECTED';

-- Category Master ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "category_master" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "CategoryStatus" NOT NULL DEFAULT 'ACTIVE',
  "subcategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "category_master_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "category_master_code_key" ON "category_master"("code");
CREATE INDEX IF NOT EXISTS "category_master_status_idx" ON "category_master"("status");

-- Category -> Zone mapping (warehouse configuration, never hardcoded) --------
CREATE TABLE IF NOT EXISTS "category_zone_mappings" (
  "id" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "zoneId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "category_zone_mappings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "category_zone_mappings_categoryId_zoneId_key"
  ON "category_zone_mappings"("categoryId", "zoneId");
CREATE INDEX IF NOT EXISTS "category_zone_mappings_zoneId_idx" ON "category_zone_mappings"("zoneId");
DO $$ BEGIN
  ALTER TABLE "category_zone_mappings" ADD CONSTRAINT "category_zone_mappings_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "category_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "category_zone_mappings" ADD CONSTRAINT "category_zone_mappings_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Classification columns on the expected line ---------------------------------
ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "subcategory" TEXT;
ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "classificationSource" TEXT;
ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW';

-- ...and their snapshots on the receiving line --------------------------------
ALTER TABLE "receiving_products" ADD COLUMN IF NOT EXISTS "subcategory" TEXT;
ALTER TABLE "receiving_products" ADD COLUMN IF NOT EXISTS "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW';

-- Backfill: lines that already carry a category from the previous phase were
-- persisted before the master existed — they stay NEEDS_REVIEW until an admin
-- confirms the master; nothing is guessed. (No data change required: the
-- column default already yields NEEDS_REVIEW.)
