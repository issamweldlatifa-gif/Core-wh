-- Station Display Mode (owner order 2026-09-16):
-- per-station READ-ONLY live displays + their audit actions.
DO $$ BEGIN
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_CREATED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_UPDATED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_ENABLED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_DISABLED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_DELETED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_ACCESS_REGENERATED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_STATION_CHANGED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationDisplayType" AS ENUM ('LIVE_STATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE "station_displays" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "displayType" "StationDisplayType" NOT NULL DEFAULT 'LIVE_STATION',
    "accessToken" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "station_displays_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "station_displays_accessToken_key" ON "station_displays"("accessToken");
CREATE INDEX "station_displays_stationId_idx" ON "station_displays"("stationId");
ALTER TABLE "station_displays" ADD CONSTRAINT "station_displays_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
