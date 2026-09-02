-- ============================================================================
-- REPAIR MIGRATION — production schema drift on Render (2026-09-02).
--
-- Incident: earlier deploys half-applied the WAREHOUSE OS migrations and the
-- ledger (_prisma_migrations) was later marked clean, so `migrate deploy`
-- reports "No pending migrations" while REAL objects are missing in the live
-- database (observed in production logs: table `putaway_sessions` does not
-- exist; column `warehouse_cartons.currentLocationId` does not exist). Every
-- request touching them 500s.
--
-- This migration is a SUPERSET re-application of everything the drifted
-- deploys should have created:
--   20260901140000  ScanSource enum + receiving device/scan-source columns
--   20260901175952  stations + operation_corrections (+ AuditAction verbs)
--   20260901191415  receiving_sessions.stationId relation
--   20260901192400  putaway_sessions + carton_placements + carton location
--   20260901192621  putaway AuditAction verbs
--
-- EVERY statement is guarded (IF NOT EXISTS / duplicate_object) so it is a
-- no-op on healthy databases and purely additive on drifted ones. It can be
-- re-applied safely any number of times. NO statement drops or rewrites data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ScanSource" AS ENUM ('CAMERA', 'EXTERNAL_SCANNER', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

DO $$ BEGIN
  CREATE TYPE "PutawaySessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enum value additions (idempotent).
ALTER TYPE "CartonStatus" ADD VALUE IF NOT EXISTS 'STORED';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UNASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CORRECTION_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_REVERSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_STORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_MOVED';

-- ---------------------------------------------------------------------------
-- Receiving device / scan-source columns (20260901140000)
-- ---------------------------------------------------------------------------
ALTER TABLE "receiving_cartons" ADD COLUMN IF NOT EXISTS "source" "ScanSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "deviceType" TEXT;
ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "deviceName" TEXT;
ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "scanSource" TEXT;

-- ---------------------------------------------------------------------------
-- Stations + corrections (20260901175952)
-- ---------------------------------------------------------------------------
ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "stationId" TEXT;

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

CREATE UNIQUE INDEX IF NOT EXISTS "stations_code_key" ON "stations"("code");
CREATE INDEX IF NOT EXISTS "stations_department_idx" ON "stations"("department");
CREATE INDEX IF NOT EXISTS "stations_status_idx" ON "stations"("status");
CREATE INDEX IF NOT EXISTS "stations_assignedWorkerId_idx" ON "stations"("assignedWorkerId");

CREATE UNIQUE INDEX IF NOT EXISTS "operation_corrections_code_key" ON "operation_corrections"("code");
CREATE INDEX IF NOT EXISTS "operation_corrections_entityType_entityId_idx" ON "operation_corrections"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "operation_corrections_receivingSessionId_idx" ON "operation_corrections"("receivingSessionId");
CREATE INDEX IF NOT EXISTS "operation_corrections_adminId_idx" ON "operation_corrections"("adminId");
CREATE INDEX IF NOT EXISTS "operation_corrections_createdAt_idx" ON "operation_corrections"("createdAt");

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

-- ---------------------------------------------------------------------------
-- Receiving session -> station relation (20260901191415)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "receiving_sessions_stationId_idx" ON "receiving_sessions"("stationId");

DO $$ BEGIN
  ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Putaway / stowing (20260901192400)
-- ---------------------------------------------------------------------------
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "currentLocationId" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "storedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "putaway_sessions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "PutawaySessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "workerId" TEXT,
    "stationId" TEXT,
    "deviceType" TEXT,
    "deviceName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "putaway_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "carton_placements" (
    "id" TEXT NOT NULL,
    "cartonId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "putawaySessionId" TEXT,
    "cartonSource" "ScanSource" NOT NULL DEFAULT 'MANUAL',
    "locationSource" "ScanSource" NOT NULL DEFAULT 'MANUAL',
    "placedBy" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carton_placements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "putaway_sessions_code_key" ON "putaway_sessions"("code");
CREATE INDEX IF NOT EXISTS "putaway_sessions_status_idx" ON "putaway_sessions"("status");
CREATE INDEX IF NOT EXISTS "putaway_sessions_workerId_idx" ON "putaway_sessions"("workerId");
CREATE INDEX IF NOT EXISTS "putaway_sessions_stationId_idx" ON "putaway_sessions"("stationId");
CREATE INDEX IF NOT EXISTS "carton_placements_cartonId_idx" ON "carton_placements"("cartonId");
CREATE INDEX IF NOT EXISTS "carton_placements_locationId_idx" ON "carton_placements"("locationId");
CREATE INDEX IF NOT EXISTS "carton_placements_putawaySessionId_idx" ON "carton_placements"("putawaySessionId");
CREATE INDEX IF NOT EXISTS "carton_placements_releasedAt_idx" ON "carton_placements"("releasedAt");
CREATE INDEX IF NOT EXISTS "warehouse_cartons_currentLocationId_idx" ON "warehouse_cartons"("currentLocationId");

DO $$ BEGIN
  ALTER TABLE "warehouse_cartons" ADD CONSTRAINT "warehouse_cartons_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_putawaySessionId_fkey" FOREIGN KEY ("putawaySessionId") REFERENCES "putaway_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
