-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('CREATED', 'SUBMITTED', 'ACCEPTED', 'SENT_TO_RECEIVING', 'RECEIVING_IN_PROGRESS', 'RECEIVING_COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "BatchIdentifierType" AS ENUM ('SKU', 'BARCODE', 'REFERENCE', 'QR', 'MANUAL');

-- CreateEnum
CREATE TYPE "BatchItemStatus" AS ENUM ('REGISTERED', 'RECEIVED');

-- AlterEnum
ALTER TYPE "CardType" ADD VALUE 'BATCH_CARD';

ALTER TYPE "AuditAction" ADD VALUE 'BATCH_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_UNIT_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_SENT_TO_RECEIVING';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_RECEIVING_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_UNIT_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_RECEIVING_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'BATCH_VOIDED';

-- CreateTable
CREATE TABLE "batch_customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalRef" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT true,
    "createdByWorkerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "batch_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ayrovi_units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "identifierType" "BatchIdentifierType" NOT NULL,
    "originalBarcode" TEXT,
    "originalSku" TEXT,
    "originalReference" TEXT,
    "createdByWorkerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ayrovi_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'WORKER_APP_BATCH',
    "status" "BatchStatus" NOT NULL DEFAULT 'CREATED',
    "totalExpected" INTEGER NOT NULL DEFAULT 0,
    "totalScanned" INTEGER NOT NULL DEFAULT 0,
    "customerId" TEXT,
    "createdById" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "submitIdempotencyKey" TEXT,
    "sendIdempotencyKey" TEXT,
    "completeReceivingIdempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_items" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "identifierType" "BatchIdentifierType" NOT NULL,
    "identifierValue" TEXT,
    "normalizedIdentifier" TEXT,
    "status" "BatchItemStatus" NOT NULL DEFAULT 'REGISTERED',
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedByWorkerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batch_customers_name_idx" ON "batch_customers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ayrovi_units_code_key" ON "ayrovi_units"("code");

-- CreateIndex
CREATE INDEX "ayrovi_units_originalSku_idx" ON "ayrovi_units"("originalSku");

-- CreateIndex
CREATE INDEX "ayrovi_units_originalBarcode_idx" ON "ayrovi_units"("originalBarcode");

-- CreateIndex
CREATE UNIQUE INDEX "batches_batchCode_key" ON "batches"("batchCode");

-- CreateIndex
CREATE UNIQUE INDEX "batches_idempotencyKey_key" ON "batches"("idempotencyKey");
CREATE UNIQUE INDEX "batches_submitIdempotencyKey_key" ON "batches"("submitIdempotencyKey");
CREATE UNIQUE INDEX "batches_sendIdempotencyKey_key" ON "batches"("sendIdempotencyKey");
CREATE UNIQUE INDEX "batches_completeReceivingIdempotencyKey_key" ON "batches"("completeReceivingIdempotencyKey");

-- CreateIndex
CREATE INDEX "batches_status_idx" ON "batches"("status");

-- CreateIndex
CREATE INDEX "batches_customerId_idx" ON "batches"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_items_unitId_key" ON "batch_items"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "batch_items_idempotencyKey_key" ON "batch_items"("idempotencyKey");

-- CreateIndex
CREATE INDEX "batch_items_batchId_idx" ON "batch_items"("batchId");

-- CreateIndex
CREATE INDEX "batch_items_normalizedIdentifier_idx" ON "batch_items"("normalizedIdentifier");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "batch_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "ayrovi_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

