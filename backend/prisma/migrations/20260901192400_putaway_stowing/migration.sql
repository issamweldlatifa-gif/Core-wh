-- Putaway / stowing: sessions + append-only carton placement ledger.
-- All statements are guarded so the migration can be safely re-applied after
-- a partially failed deploy (see 20260901175952 for the incident).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PutawaySessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterEnum
ALTER TYPE "CartonStatus" ADD VALUE IF NOT EXISTS 'STORED';

-- AlterTable
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "currentLocationId" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "storedAt" TIMESTAMP(3);

-- CreateTable
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

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "putaway_sessions_code_key" ON "putaway_sessions"("code");
CREATE INDEX IF NOT EXISTS "putaway_sessions_status_idx" ON "putaway_sessions"("status");
CREATE INDEX IF NOT EXISTS "putaway_sessions_workerId_idx" ON "putaway_sessions"("workerId");
CREATE INDEX IF NOT EXISTS "putaway_sessions_stationId_idx" ON "putaway_sessions"("stationId");
CREATE INDEX IF NOT EXISTS "carton_placements_cartonId_idx" ON "carton_placements"("cartonId");
CREATE INDEX IF NOT EXISTS "carton_placements_locationId_idx" ON "carton_placements"("locationId");
CREATE INDEX IF NOT EXISTS "carton_placements_putawaySessionId_idx" ON "carton_placements"("putawaySessionId");
CREATE INDEX IF NOT EXISTS "carton_placements_releasedAt_idx" ON "carton_placements"("releasedAt");
CREATE INDEX IF NOT EXISTS "warehouse_cartons_currentLocationId_idx" ON "warehouse_cartons"("currentLocationId");

-- AddForeignKey
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
