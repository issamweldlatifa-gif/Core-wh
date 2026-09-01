-- Inbound Shipments (Shipment Cards) + Receiving module.
-- Shipment cards carry physical shipping/carton data and link to Expected
-- Arrivals. Receiving turns EXPECTED records into physical receipts without
-- ever overwriting the expected data.

-- ===== New audit actions =====
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHIPMENT_CARD_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CARTON_SCANNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CARTON_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CARTON_MANUAL_ENTRY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNKNOWN_CARTON';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WRONG_SHIPMENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DUPLICATE_CARTON';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRODUCT_SCANNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRODUCT_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNEXPECTED_PRODUCT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISCREPANCY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISCREPANCY_RESOLVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_COMPLETED_WITH_DISCREPANCY';

-- ===== Expected Arrival lifecycle: add receiving states =====
ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'RECEIVING';
ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'RECEIVED_WITH_DISCREPANCY';

-- ===== Shipment enums =====
CREATE TYPE "ShipmentSourceType" AS ENUM ('MANUAL', 'CARRIER_API', 'IMPORT', 'OTHER');
CREATE TYPE "ShipmentTrackingStatus" AS ENUM ('CREATED', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'UNKNOWN');
CREATE TYPE "CartonStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'FLAGGED', 'WRONG_SHIPMENT');

-- ===== Receiving enums =====
CREATE TYPE "ReceivingSessionStatus" AS ENUM ('RECEIVING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'CANCELLED');
CREATE TYPE "ScanType" AS ENUM ('QR', 'BARCODE', 'MANUAL');
CREATE TYPE "ReceivingProductStatus" AS ENUM ('EXPECTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'SHORT', 'OVERAGE', 'UNEXPECTED', 'NEEDS_REVIEW');
CREATE TYPE "DiscrepancyType" AS ENUM ('SHORTAGE', 'OVERAGE', 'UNKNOWN_CARTON', 'WRONG_SHIPMENT', 'DUPLICATE_SCAN', 'UNEXPECTED_PRODUCT', 'MISSING_PRODUCT', 'MISSING_CARTON', 'IDENTIFICATION_ERROR', 'OTHER');
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

-- ===== warehouse_shipments =====
CREATE TABLE "warehouse_shipments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "externalShipmentId" TEXT NOT NULL,
    "shipmentReference" TEXT,
    "idempotencyKey" TEXT,
    "arrivalId" TEXT,
    "externalArrivalId" TEXT,
    "arrivalReference" TEXT,
    "sourceType" "ShipmentSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceReference" TEXT,
    "carrierId" TEXT,
    "carrierName" TEXT,
    "carrierCode" TEXT,
    "serviceName" TEXT,
    "carrierAccountReference" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "trackingStatus" "ShipmentTrackingStatus" NOT NULL DEFAULT 'UNKNOWN',
    "masterTrackingNumber" TEXT,
    "carrierTrackingReference" TEXT,
    "senderName" TEXT,
    "senderCompany" TEXT,
    "senderCountry" TEXT,
    "senderCity" TEXT,
    "senderReference" TEXT,
    "senderAddress" TEXT,
    "senderPhone" TEXT,
    "senderEmail" TEXT,
    "destinationCountry" TEXT,
    "destinationCity" TEXT,
    "destinationCode" TEXT,
    "destinationReference" TEXT,
    "shipmentCreatedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "estimatedArrivalAt" TIMESTAMP(3),
    "actualArrivalAt" TIMESTAMP(3),
    "totalCartons" INTEGER NOT NULL DEFAULT 0,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "totalWeight" DOUBLE PRECISION,
    "weightUnit" TEXT,
    "apiClientId" TEXT,
    "receivedViaApi" BOOLEAN NOT NULL DEFAULT true,
    "receivedViaApiAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_shipments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_shipments_code_key" ON "warehouse_shipments"("code");
CREATE UNIQUE INDEX "warehouse_shipments_externalShipmentId_key" ON "warehouse_shipments"("externalShipmentId");
CREATE INDEX "warehouse_shipments_arrivalId_idx" ON "warehouse_shipments"("arrivalId");
CREATE INDEX "warehouse_shipments_carrierCode_idx" ON "warehouse_shipments"("carrierCode");
CREATE INDEX "warehouse_shipments_trackingNumber_idx" ON "warehouse_shipments"("trackingNumber");
CREATE INDEX "warehouse_shipments_trackingStatus_idx" ON "warehouse_shipments"("trackingStatus");

ALTER TABLE "warehouse_shipments"
  ADD CONSTRAINT "warehouse_shipments_arrivalId_fkey"
  FOREIGN KEY ("arrivalId") REFERENCES "expected_arrivals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== warehouse_cartons =====
CREATE TABLE "warehouse_cartons" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "externalCartonId" TEXT NOT NULL,
    "cartonReference" TEXT,
    "qrCodeValue" TEXT,
    "barcodeValue" TEXT,
    "cartonNumber" INTEGER NOT NULL DEFAULT 1,
    "totalCartons" INTEGER NOT NULL DEFAULT 1,
    "status" "CartonStatus" NOT NULL DEFAULT 'EXPECTED',
    "weight" DOUBLE PRECISION,
    "weightUnit" TEXT,
    "length" DOUBLE PRECISION,
    "width" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "dimensionUnit" TEXT,
    "receivedAt" TIMESTAMP(3),
    "receivedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_cartons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_cartons_externalCartonId_key" ON "warehouse_cartons"("externalCartonId");
CREATE INDEX "warehouse_cartons_shipmentId_idx" ON "warehouse_cartons"("shipmentId");
CREATE INDEX "warehouse_cartons_status_idx" ON "warehouse_cartons"("status");
CREATE INDEX "warehouse_cartons_qrCodeValue_idx" ON "warehouse_cartons"("qrCodeValue");
CREATE INDEX "warehouse_cartons_barcodeValue_idx" ON "warehouse_cartons"("barcodeValue");

ALTER TABLE "warehouse_cartons"
  ADD CONSTRAINT "warehouse_cartons_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "warehouse_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== receiving_sessions =====
CREATE TABLE "receiving_sessions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "arrivalId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "status" "ReceivingSessionStatus" NOT NULL DEFAULT 'RECEIVING',
    "startedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receiving_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_sessions_code_key" ON "receiving_sessions"("code");
CREATE INDEX "receiving_sessions_arrivalId_idx" ON "receiving_sessions"("arrivalId");
CREATE INDEX "receiving_sessions_status_idx" ON "receiving_sessions"("status");

ALTER TABLE "receiving_sessions"
  ADD CONSTRAINT "receiving_sessions_arrivalId_fkey"
  FOREIGN KEY ("arrivalId") REFERENCES "expected_arrivals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receiving_sessions"
  ADD CONSTRAINT "receiving_sessions_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "warehouse_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== receiving_cartons =====
CREATE TABLE "receiving_cartons" (
    "id" TEXT NOT NULL,
    "receivingSessionId" TEXT NOT NULL,
    "cartonId" TEXT,
    "scannedCode" TEXT NOT NULL,
    "scanType" "ScanType" NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3),
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_cartons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_cartons_operationId_key" ON "receiving_cartons"("operationId");
CREATE INDEX "receiving_cartons_receivingSessionId_idx" ON "receiving_cartons"("receivingSessionId");
CREATE INDEX "receiving_cartons_cartonId_idx" ON "receiving_cartons"("cartonId");

ALTER TABLE "receiving_cartons"
  ADD CONSTRAINT "receiving_cartons_receivingSessionId_fkey"
  FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receiving_cartons"
  ADD CONSTRAINT "receiving_cartons_cartonId_fkey"
  FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== receiving_products =====
CREATE TABLE "receiving_products" (
    "id" TEXT NOT NULL,
    "receivingSessionId" TEXT NOT NULL,
    "arrivalItemId" TEXT,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "expectedQuantity" INTEGER NOT NULL DEFAULT 0,
    "receivedQuantity" INTEGER NOT NULL DEFAULT 0,
    "difference" INTEGER NOT NULL DEFAULT 0,
    "status" "ReceivingProductStatus" NOT NULL DEFAULT 'EXPECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receiving_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receiving_products_session_sku_key" ON "receiving_products"("receivingSessionId", "sku");
CREATE INDEX "receiving_products_receivingSessionId_idx" ON "receiving_products"("receivingSessionId");
CREATE INDEX "receiving_products_status_idx" ON "receiving_products"("status");

ALTER TABLE "receiving_products"
  ADD CONSTRAINT "receiving_products_receivingSessionId_fkey"
  FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== receiving_discrepancies =====
CREATE TABLE "receiving_discrepancies" (
    "id" TEXT NOT NULL,
    "receivingSessionId" TEXT NOT NULL,
    "cartonId" TEXT,
    "receivingProductId" TEXT,
    "type" "DiscrepancyType" NOT NULL,
    "expectedQuantity" INTEGER,
    "actualQuantity" INTEGER,
    "difference" INTEGER,
    "reason" TEXT,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "receiving_discrepancies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receiving_discrepancies_receivingSessionId_idx" ON "receiving_discrepancies"("receivingSessionId");
CREATE INDEX "receiving_discrepancies_status_idx" ON "receiving_discrepancies"("status");
CREATE INDEX "receiving_discrepancies_type_idx" ON "receiving_discrepancies"("type");

ALTER TABLE "receiving_discrepancies"
  ADD CONSTRAINT "receiving_discrepancies_receivingSessionId_fkey"
  FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
