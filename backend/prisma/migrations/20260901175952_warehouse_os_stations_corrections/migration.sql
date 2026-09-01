-- CreateEnum
CREATE TYPE "StationDepartment" AS ENUM ('RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH');

-- CreateEnum
CREATE TYPE "StationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "StationCapability" AS ENUM ('CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE');

-- CreateEnum
CREATE TYPE "CorrectionAction" AS ENUM ('REVERSE_RECEIVING', 'CORRECT_PRODUCT', 'CORRECT_QUANTITY', 'REASSIGN_SESSION', 'REOPEN_SESSION', 'VOID_OPERATION', 'RESOLVE_EXCEPTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'STATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'STATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'STATION_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'STATION_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE 'STATION_UNASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE 'CORRECTION_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'RECEIVING_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE 'SESSION_REASSIGNED';

-- AlterTable
ALTER TABLE "receiving_sessions" ADD COLUMN     "stationId" TEXT;

-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" "StationDepartment" NOT NULL,
    "status" "StationStatus" NOT NULL DEFAULT 'ACTIVE',
    "assignedWorkerId" TEXT,
    "deviceId" TEXT,
    "capabilities" "StationCapability"[] DEFAULT ARRAY[]::"StationCapability"[],
    "warehouseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_corrections" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "action" "CorrectionAction" NOT NULL,
    "reason" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "receivingSessionId" TEXT,
    "stationId" TEXT,
    "workerId" TEXT,
    "originalSnapshot" JSONB NOT NULL,
    "newSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operation_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stations_code_key" ON "stations"("code");

-- CreateIndex
CREATE INDEX "stations_department_idx" ON "stations"("department");

-- CreateIndex
CREATE INDEX "stations_status_idx" ON "stations"("status");

-- CreateIndex
CREATE INDEX "stations_assignedWorkerId_idx" ON "stations"("assignedWorkerId");

-- CreateIndex
CREATE UNIQUE INDEX "operation_corrections_code_key" ON "operation_corrections"("code");

-- CreateIndex
CREATE INDEX "operation_corrections_entityType_entityId_idx" ON "operation_corrections"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "operation_corrections_receivingSessionId_idx" ON "operation_corrections"("receivingSessionId");

-- CreateIndex
CREATE INDEX "operation_corrections_adminId_idx" ON "operation_corrections"("adminId");

-- CreateIndex
CREATE INDEX "operation_corrections_createdAt_idx" ON "operation_corrections"("createdAt");

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_assignedWorkerId_fkey" FOREIGN KEY ("assignedWorkerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stations" ADD CONSTRAINT "stations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_receivingSessionId_fkey" FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "receiving_products_session_sku_key" RENAME TO "receiving_products_receivingSessionId_sku_key";
