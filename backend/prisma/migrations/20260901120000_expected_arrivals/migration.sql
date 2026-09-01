-- Expected Arrivals (Arrival CRM integration)
-- A Customer Arrival Card pushed by the AYROVI Arrival CRM is stored as an
-- Expected Arrival (status EXPECTED). Receiving/scanning/putaway/inventory are
-- explicitly out of scope for this phase.

-- CreateEnum: source of the Expected Arrival
CREATE TYPE "ExpectedArrivalSource" AS ENUM ('ARRIVAL_CRM');

-- CreateEnum: lifecycle status. Only EXPECTED is settable now;
-- RECEIVED / CANCELLED are reserved for later phases and intentionally omitted.
CREATE TYPE "ExpectedArrivalStatus" AS ENUM ('EXPECTED');

-- AlterEnum: register the new audit action on the existing AuditAction type.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_ARRIVAL_CARD_RECEIVED';

-- CreateTable: the Expected Arrival header.
CREATE TABLE "expected_arrivals" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerArrivalCardId" TEXT NOT NULL,
    "arrivalId" TEXT,
    "arrivalReference" TEXT,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "storeId" TEXT,
    "storeName" TEXT,
    "status" "ExpectedArrivalStatus" NOT NULL DEFAULT 'EXPECTED',
    "source" "ExpectedArrivalSource" NOT NULL DEFAULT 'ARRIVAL_CRM',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "apiClientId" TEXT,
    "idempotencyKey" TEXT,
    "receivedViaApi" BOOLEAN NOT NULL DEFAULT true,
    "receivedViaApiAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expected_arrivals_pkey" PRIMARY KEY ("id")
);

-- CreateTable: store-agnostic product lines attached to an Expected Arrival.
-- Every product field except the line id is nullable (products may lack SKU,
-- reference, variant, color or size); quantity defaults to 1 and is >= 1.
CREATE TABLE "expected_arrival_items" (
    "id" TEXT NOT NULL,
    "arrivalId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "variant" TEXT,
    "color" TEXT,
    "size" TEXT,
    "storeId" TEXT,
    "storeName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expected_arrival_items_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "expected_arrivals_code_key" ON "expected_arrivals"("code");
CREATE UNIQUE INDEX "expected_arrivals_customerArrivalCardId_key" ON "expected_arrivals"("customerArrivalCardId");
CREATE INDEX "expected_arrivals_status_idx" ON "expected_arrivals"("status");
CREATE INDEX "expected_arrivals_customerId_idx" ON "expected_arrivals"("customerId");
CREATE INDEX "expected_arrivals_storeId_idx" ON "expected_arrivals"("storeId");
CREATE INDEX "expected_arrivals_source_idx" ON "expected_arrivals"("source");

CREATE INDEX "expected_arrival_items_arrivalId_idx" ON "expected_arrival_items"("arrivalId");
CREATE INDEX "expected_arrival_items_sku_idx" ON "expected_arrival_items"("sku");

-- DB-level guard: quantities are always at least 1 (DTO also enforces 1..100000).
ALTER TABLE "expected_arrival_items"
  ADD CONSTRAINT "expected_arrival_items_quantity_check" CHECK ("quantity" >= 1);

-- Foreign key: deleting an Expected Arrival cascades to its product lines.
ALTER TABLE "expected_arrival_items"
  ADD CONSTRAINT "expected_arrival_items_arrivalId_fkey"
  FOREIGN KEY ("arrivalId") REFERENCES "expected_arrivals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
