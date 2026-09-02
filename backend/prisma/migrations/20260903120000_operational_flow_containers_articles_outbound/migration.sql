-- OPERATIONAL WAREHOUSE FLOW
-- Containers (QR totes + customer bins), per-piece ArticleUnits born at the
-- receiving scan, and outbound shipments created at packing. Additive-only:
-- no existing table/enum value is altered or removed. Guarded for replay.

-- Enums --------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ContainerType" AS ENUM ('RECEIVING', 'CUSTOMER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContainerStatus" AS ENUM ('ACTIVE', 'READY_FOR_PACKING', 'PACKED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ArticleUnitStatus" AS ENUM ('RECEIVED', 'IN_CONTAINER', 'STORED', 'IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "OutboundShipmentStatus" AS ENUM ('READY_TO_SHIP', 'SHIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Audit actions --------------------------------------------------------------
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_READY_FOR_PACKING';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ARTICLE_SCANNED';

-- Operational containers ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "operational_containers" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "ContainerType" NOT NULL,
  "status" "ContainerStatus" NOT NULL DEFAULT 'ACTIVE',
  "label" TEXT,
  "orderId" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operational_containers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "operational_containers_code_key" ON "operational_containers"("code");
CREATE INDEX IF NOT EXISTS "operational_containers_type_status_idx" ON "operational_containers"("type", "status");
CREATE INDEX IF NOT EXISTS "operational_containers_orderId_idx" ON "operational_containers"("orderId");
DO $$ BEGIN
  ALTER TABLE "operational_containers" ADD CONSTRAINT "operational_containers_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Outbound shipments ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "outbound_shipments" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "containerId" TEXT,
  "status" "OutboundShipmentStatus" NOT NULL DEFAULT 'READY_TO_SHIP',
  "carrier" TEXT,
  "trackingNumber" TEXT,
  "packedBy" TEXT,
  "packedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "shippedBy" TEXT,
  "shippedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbound_shipments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_shipments_code_key" ON "outbound_shipments"("code");
CREATE INDEX IF NOT EXISTS "outbound_shipments_orderId_idx" ON "outbound_shipments"("orderId");
CREATE INDEX IF NOT EXISTS "outbound_shipments_status_idx" ON "outbound_shipments"("status");
DO $$ BEGIN
  ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_containerId_fkey"
    FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Article units ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "article_units" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "productName" TEXT,
  "category" TEXT,
  "subcategory" TEXT,
  "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "status" "ArticleUnitStatus" NOT NULL DEFAULT 'RECEIVED',
  "arrivalItemId" TEXT,
  "receivingSessionId" TEXT,
  "sourceCartonId" TEXT,
  "containerId" TEXT,
  "currentLocationId" TEXT,
  "storedAt" TIMESTAMP(3),
  "orderId" TEXT,
  "orderItemId" TEXT,
  "outboundShipmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "article_units_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "article_units_code_key" ON "article_units"("code");
CREATE INDEX IF NOT EXISTS "article_units_sku_idx" ON "article_units"("sku");
CREATE INDEX IF NOT EXISTS "article_units_status_idx" ON "article_units"("status");
CREATE INDEX IF NOT EXISTS "article_units_containerId_idx" ON "article_units"("containerId");
CREATE INDEX IF NOT EXISTS "article_units_currentLocationId_idx" ON "article_units"("currentLocationId");
CREATE INDEX IF NOT EXISTS "article_units_orderId_idx" ON "article_units"("orderId");
CREATE INDEX IF NOT EXISTS "article_units_receivingSessionId_idx" ON "article_units"("receivingSessionId");
CREATE INDEX IF NOT EXISTS "article_units_outboundShipmentId_idx" ON "article_units"("outboundShipmentId");
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_arrivalItemId_fkey"
    FOREIGN KEY ("arrivalItemId") REFERENCES "expected_arrival_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_receivingSessionId_fkey"
    FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_sourceCartonId_fkey"
    FOREIGN KEY ("sourceCartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_containerId_fkey"
    FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_currentLocationId_fkey"
    FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_orderItemId_fkey"
    FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "article_units" ADD CONSTRAINT "article_units_outboundShipmentId_fkey"
    FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
