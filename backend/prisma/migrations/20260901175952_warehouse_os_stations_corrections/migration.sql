-- WAREHOUSE OS: stations + append-only operation corrections.
--
-- This migration is written to be RE-RUNNABLE. A previous deploy on Render
-- aborted midway (the enums were created, then the transaction died), which
-- left the database in a half-applied state: every later deploy then crashed
-- with P3018 / 42710 `type "StationStatus" already exists` and no migration
-- could ever be applied again.
--
-- Postgres runs each migration in a transaction, but `prisma migrate deploy`
-- marks the migration as failed and refuses to retry it, so the guards below
-- make re-application safe instead of fatal. Every statement is expressed as
-- "create only if missing".

-- CreateEnum (guarded: may already exist from a partially applied deploy)
DO $$ BEGIN
  CREATE TYPE "StationDepartment" AS ENUM ('RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationCapability" AS ENUM ('CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CorrectionAction" AS ENUM ('REVERSE_RECEIVING', 'CORRECT_PRODUCT', 'CORRECT_QUANTITY', 'REASSIGN_SESSION', 'REOPEN_SESSION', 'VOID_OPERATION', 'RESOLVE_EXCEPTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterEnum: extend AuditAction. `IF NOT EXISTS` makes each value idempotent.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UNASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CORRECTION_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REASSIGNED';

-- AlterTable
ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "stationId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "stations" (
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
CREATE TABLE IF NOT EXISTS "operation_corrections" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "stations_code_key" ON "stations"("code");
CREATE INDEX IF NOT EXISTS "stations_department_idx" ON "stations"("department");
CREATE INDEX IF NOT EXISTS "stations_status_idx" ON "stations"("status");
CREATE INDEX IF NOT EXISTS "stations_assignedWorkerId_idx" ON "stations"("assignedWorkerId");
CREATE UNIQUE INDEX IF NOT EXISTS "operation_corrections_code_key" ON "operation_corrections"("code");
CREATE INDEX IF NOT EXISTS "operation_corrections_entityType_entityId_idx" ON "operation_corrections"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "operation_corrections_receivingSessionId_idx" ON "operation_corrections"("receivingSessionId");
CREATE INDEX IF NOT EXISTS "operation_corrections_adminId_idx" ON "operation_corrections"("adminId");
CREATE INDEX IF NOT EXISTS "operation_corrections_createdAt_idx" ON "operation_corrections"("createdAt");

-- AddForeignKey (guarded: constraints have no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  ALTER TABLE "stations" ADD CONSTRAINT "stations_assignedWorkerId_fkey" FOREIGN KEY ("assignedWorkerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "stations" ADD CONSTRAINT "stations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_receivingSessionId_fkey" FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RenameIndex (guarded: only rename when the old name is still present)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'receiving_products_session_sku_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'receiving_products_receivingSessionId_sku_key') THEN
    ALTER INDEX "receiving_products_session_sku_key" RENAME TO "receiving_products_receivingSessionId_sku_key";
  END IF;
END $$;
