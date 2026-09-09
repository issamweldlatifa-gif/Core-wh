-- CreateEnum
CREATE TYPE "TempContainerStatus" AS ENUM ('EMPTY', 'ACTIVE', 'FULL', 'REVIEW');

-- CreateEnum
CREATE TYPE "TempStorageItemStatus" AS ENUM ('STORED', 'REVIEW');

-- CreateEnum
CREATE TYPE "TemporaryStorageReportStatus" AS ENUM ('SUBMITTED', 'REVIEWED', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_STORED_IN_TEMP_CONTAINER';
ALTER TYPE "AuditAction" ADD VALUE 'TEMP_SCAN_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTAINER_FULL';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPORARY_STORAGE_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'CARTON_CLOSED_AT_RECEIVING';

-- AlterTable
ALTER TABLE "expected_arrivals" ADD COLUMN     "customerSurname" TEXT;

-- CreateTable
CREATE TABLE "temporary_storage_containers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "sectionLetter" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 20,
    "currentQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" "TempContainerStatus" NOT NULL DEFAULT 'ACTIVE',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temporary_storage_containers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_storage_items" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "containerId" TEXT,
    "productMoveId" TEXT,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "customerName" TEXT,
    "sectionLetter" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "TempStorageItemStatus" NOT NULL DEFAULT 'STORED',
    "reviewReason" TEXT,
    "scannedBy" TEXT,
    "deviceType" TEXT,
    "deviceName" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_storage_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "temporary_storage_reports" (
    "id" TEXT NOT NULL,
    "stationId" TEXT,
    "stationCode" TEXT,
    "workerId" TEXT,
    "workerName" TEXT,
    "deviceType" TEXT,
    "deviceName" TEXT,
    "status" "TemporaryStorageReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "observation" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sectionsProcessed" JSONB,
    "containersUsed" INTEGER NOT NULL DEFAULT 0,
    "productsReceived" INTEGER NOT NULL DEFAULT 0,
    "productsStored" INTEGER NOT NULL DEFAULT 0,
    "productsInReview" INTEGER NOT NULL DEFAULT 0,
    "exceptions" INTEGER NOT NULL DEFAULT 0,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temporary_storage_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "temporary_storage_containers_stationId_status_idx" ON "temporary_storage_containers"("stationId", "status");

-- CreateIndex
CREATE INDEX "temporary_storage_containers_sectionLetter_idx" ON "temporary_storage_containers"("sectionLetter");

-- CreateIndex
CREATE UNIQUE INDEX "temporary_storage_containers_stationId_code_key" ON "temporary_storage_containers"("stationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "temporary_storage_items_operationId_key" ON "temporary_storage_items"("operationId");

-- CreateIndex
CREATE INDEX "temporary_storage_items_containerId_idx" ON "temporary_storage_items"("containerId");

-- CreateIndex
CREATE INDEX "temporary_storage_items_productMoveId_idx" ON "temporary_storage_items"("productMoveId");

-- CreateIndex
CREATE INDEX "temporary_storage_items_status_idx" ON "temporary_storage_items"("status");

-- CreateIndex
CREATE INDEX "temporary_storage_reports_stationId_finishedAt_idx" ON "temporary_storage_reports"("stationId", "finishedAt");

-- CreateIndex
CREATE INDEX "temporary_storage_reports_status_idx" ON "temporary_storage_reports"("status");

-- AddForeignKey
ALTER TABLE "temporary_storage_items" ADD CONSTRAINT "temporary_storage_items_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "temporary_storage_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "temporary_storage_items" ADD CONSTRAINT "temporary_storage_items_productMoveId_fkey" FOREIGN KEY ("productMoveId") REFERENCES "product_station_moves"("id") ON DELETE SET NULL ON UPDATE CASCADE;

