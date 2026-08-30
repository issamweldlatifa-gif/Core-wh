/*
  Warnings:

  - You are about to drop the column `address` on the `warehouses` table. All the data in the column will be lost.
  - The `status` column on the `warehouses` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ZoneStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "AisleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RackStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "LevelStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('STORAGE', 'RECEIVING', 'SORTING', 'PACKING', 'RETURNS', 'QC', 'STAGING');

-- CreateEnum
CREATE TYPE "LocationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'WAREHOUSE_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'ZONE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ZONE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ZONE_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'ZONE_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'AISLE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'AISLE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'AISLE_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'AISLE_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'RACK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RACK_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'RACK_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'RACK_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEVEL_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEVEL_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEVEL_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'LEVEL_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_BLOCKED';
ALTER TYPE "AuditAction" ADD VALUE 'LOCATION_UNBLOCKED';

-- Data migration (D-32): existing OPERATIONAL rows -> ACTIVE, and preserve any
-- legacy address into description before the columns are altered. This is a
-- forward, idempotent-safe conversion so existing Phase-0 rows are not lost.
ALTER TABLE "warehouses" ADD COLUMN "description" TEXT;
UPDATE "warehouses" SET "description" = COALESCE("description", "address") WHERE "address" IS NOT NULL;
UPDATE "warehouses" SET "status" = 'ACTIVE' WHERE "status" NOT IN ('ACTIVE', 'INACTIVE');

-- AlterTable: convert the text status to the enum without dropping data.
ALTER TABLE "warehouses" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "warehouses"
  ALTER COLUMN "status" TYPE "WarehouseStatus" USING ("status"::text::"WarehouseStatus");
ALTER TABLE "warehouses" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
ALTER TABLE "warehouses" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "warehouses" DROP COLUMN "address";

-- CreateTable
CREATE TABLE "zones" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ZoneStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aisles" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "AisleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aisles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "racks" (
    "id" TEXT NOT NULL,
    "aisleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RackStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "racks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "levels" (
    "id" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "levelNumber" INTEGER NOT NULL,
    "status" "LevelStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "aisleId" TEXT NOT NULL,
    "rackId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "locationCode" TEXT NOT NULL,
    "barcodeValue" TEXT NOT NULL,
    "qrValue" TEXT,
    "locationType" "LocationType" NOT NULL,
    "status" "LocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxWeight" DOUBLE PRECISION,
    "maxVolume" DOUBLE PRECISION,
    "maxUnits" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zones_warehouseId_idx" ON "zones"("warehouseId");

-- CreateIndex
CREATE INDEX "zones_status_idx" ON "zones"("status");

-- CreateIndex
CREATE UNIQUE INDEX "zones_warehouseId_code_key" ON "zones"("warehouseId", "code");

-- CreateIndex
CREATE INDEX "aisles_zoneId_idx" ON "aisles"("zoneId");

-- CreateIndex
CREATE INDEX "aisles_status_idx" ON "aisles"("status");

-- CreateIndex
CREATE UNIQUE INDEX "aisles_zoneId_code_key" ON "aisles"("zoneId", "code");

-- CreateIndex
CREATE INDEX "racks_aisleId_idx" ON "racks"("aisleId");

-- CreateIndex
CREATE INDEX "racks_status_idx" ON "racks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "racks_aisleId_code_key" ON "racks"("aisleId", "code");

-- CreateIndex
CREATE INDEX "levels_rackId_idx" ON "levels"("rackId");

-- CreateIndex
CREATE INDEX "levels_status_idx" ON "levels"("status");

-- CreateIndex
CREATE UNIQUE INDEX "levels_rackId_code_key" ON "levels"("rackId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "locations_locationCode_key" ON "locations"("locationCode");

-- CreateIndex
CREATE UNIQUE INDEX "locations_barcodeValue_key" ON "locations"("barcodeValue");

-- CreateIndex
CREATE UNIQUE INDEX "locations_qrValue_key" ON "locations"("qrValue");

-- CreateIndex
CREATE INDEX "locations_warehouseId_idx" ON "locations"("warehouseId");

-- CreateIndex
CREATE INDEX "locations_zoneId_idx" ON "locations"("zoneId");

-- CreateIndex
CREATE INDEX "locations_aisleId_idx" ON "locations"("aisleId");

-- CreateIndex
CREATE INDEX "locations_rackId_idx" ON "locations"("rackId");

-- CreateIndex
CREATE INDEX "locations_levelId_idx" ON "locations"("levelId");

-- CreateIndex
CREATE INDEX "locations_status_idx" ON "locations"("status");

-- CreateIndex
CREATE INDEX "warehouses_status_idx" ON "warehouses"("status");

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aisles" ADD CONSTRAINT "aisles_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "racks" ADD CONSTRAINT "racks_aisleId_fkey" FOREIGN KEY ("aisleId") REFERENCES "aisles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "levels" ADD CONSTRAINT "levels_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "racks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_aisleId_fkey" FOREIGN KEY ("aisleId") REFERENCES "aisles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_rackId_fkey" FOREIGN KEY ("rackId") REFERENCES "racks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
