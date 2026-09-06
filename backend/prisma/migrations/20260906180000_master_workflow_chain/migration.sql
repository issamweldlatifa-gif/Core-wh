-- MASTER WORKFLOW CHAIN — Phase 2 data-model reconciliation.
--
-- Purpose (Master Order §9/§11/§12/§15/§17/§18/§26):
--   * temporary storage stations: station ↔ zone configuration (§11)
--   * container staging fields: closed tote → staging station/zone (§11)
--   * customer container QR + lock metadata (§15)
--   * customer name/surname projection on orders for cards + bordereau search (§12/§18)
--   * shipping pre-dispatch verification bound to shipment + content hash (§17)
--   * cross-stage operational exceptions (generalised, receiving-agnostic) (§7/§14/§26)
--   * audit actions for dispatch/staging/QR/lock/verification/exceptions
--   * correction action to reopen a locked customer bin (authorized admin only)
--
-- Guarded and additive: every statement is idempotent (IF NOT EXISTS /
-- duplicate_object). Nothing is dropped, altered destructively, or rewritten.

-- ---------------------------------------------------------------- enum values
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_AUTO_DISPATCHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_STAGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_QR_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_CONTAINER_LOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_CONTAINER_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHIPPING_VERIFIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXCEPTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXCEPTION_RESOLVED';
ALTER TYPE "StationDepartment" ADD VALUE IF NOT EXISTS 'STAGING';
ALTER TYPE "CorrectionAction" ADD VALUE IF NOT EXISTS 'REOPEN_CUSTOMER_BIN';

DO $$ BEGIN
  CREATE TYPE "OperationalExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------- station ↔ zone configuration
ALTER TABLE "stations" ADD COLUMN IF NOT EXISTS "zoneId" TEXT;
CREATE INDEX IF NOT EXISTS "stations_zoneId_idx" ON "stations"("zoneId");
DO $$ BEGIN
  ALTER TABLE "stations" ADD CONSTRAINT "stations_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------- container staging + customer QR
ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "qrValue" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "operational_containers_qrValue_key" ON "operational_containers"("qrValue");
ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagingStationId" TEXT;
CREATE INDEX IF NOT EXISTS "operational_containers_stagingStationId_idx" ON "operational_containers"("stagingStationId");
ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagedAt" TIMESTAMP(3);
ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagedById" TEXT;
DO $$ BEGIN
  ALTER TABLE "operational_containers" ADD CONSTRAINT "operational_containers_stagingStationId_fkey"
    FOREIGN KEY ("stagingStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------- customer name/surname (orders)
ALTER TABLE "warehouse_orders" ADD COLUMN IF NOT EXISTS "customerName" TEXT;
ALTER TABLE "warehouse_orders" ADD COLUMN IF NOT EXISTS "customerSurname" TEXT;
CREATE INDEX IF NOT EXISTS "warehouse_orders_customerName_idx" ON "warehouse_orders"("customerName");
CREATE INDEX IF NOT EXISTS "warehouse_orders_customerSurname_idx" ON "warehouse_orders"("customerSurname");

-- ------------------------------------------------- shipping verifications
DO $$ BEGIN
  CREATE TABLE "shipping_verifications" (
    "id" TEXT NOT NULL,
    "outboundShipmentId" TEXT NOT NULL,
    "verifiedById" TEXT,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipping_verifications_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "shipping_verifications_outboundShipmentId_idx" ON "shipping_verifications"("outboundShipmentId");
DO $$ BEGIN
  ALTER TABLE "shipping_verifications" ADD CONSTRAINT "shipping_verifications_outboundShipmentId_fkey"
    FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------- operational exceptions
DO $$ BEGIN
  CREATE TABLE "operational_exceptions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "OperationalExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityCode" TEXT,
    "taskKey" TEXT,
    "reason" TEXT NOT NULL,
    "reportedById" TEXT,
    "stationId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operational_exceptions_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "operational_exceptions_code_key" ON "operational_exceptions"("code");
CREATE INDEX IF NOT EXISTS "operational_exceptions_status_idx" ON "operational_exceptions"("status");
CREATE INDEX IF NOT EXISTS "operational_exceptions_type_idx" ON "operational_exceptions"("type");
DO $$ BEGIN
  ALTER TABLE "operational_exceptions" ADD CONSTRAINT "operational_exceptions_stationId_fkey"
    FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
