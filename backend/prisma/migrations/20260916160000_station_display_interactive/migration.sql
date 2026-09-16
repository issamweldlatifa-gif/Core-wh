-- Station Display v2 — INTERACTIVE (owner order 2026-09-16, stage 2):
-- displays may trigger station actions (print / reprint / acknowledge / help /
-- exception) and receive operator messages. Additive only.
--
-- Security note (owner decision, recorded): actions travel on the SAME display
-- token URL, so they are allowed ONLY when config.interactive === true (opt-in
-- per display, default OFF), are rate-limited, and are audited with the
-- display's identity. Disabling a display or regenerating its token revokes
-- both read AND write instantly.

-- 1) Audit vocabulary (safe on PG 12+, idempotent).
DO $$ BEGIN
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_ACTION_ACK';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_HELP_REQUESTED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_EXCEPTION_RAISED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_PRINT_REQUESTED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_PRINT_COMPLETED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_PRINT_FAILED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_MESSAGE_SENT';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_MESSAGE_ACK';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_BULK_CREATED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_BULK_CONFIGURED';
  ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_BULK_ENABLED_CHANGED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Display action log (the «record every action» feed).
CREATE TABLE IF NOT EXISTS "station_display_actions" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT,
    "refId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "station_display_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "station_display_actions_displayId_createdAt_idx" ON "station_display_actions"("displayId", "createdAt");
CREATE INDEX IF NOT EXISTS "station_display_actions_stationId_createdAt_idx" ON "station_display_actions"("stationId", "createdAt");
DO $$ BEGIN ALTER TABLE "station_display_actions" ADD CONSTRAINT "station_display_actions_displayId_fkey"
  FOREIGN KEY ("displayId") REFERENCES "station_displays"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Print jobs (transport pluggable: BROWSER default, BRIDGE / CT40 optional).
CREATE TABLE IF NOT EXISTS "station_print_jobs" (
    "id" TEXT NOT NULL,
    "displayId" TEXT,
    "stationId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "targetRef" TEXT,
    "payload" JSONB NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'BROWSER',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "copies" INTEGER NOT NULL DEFAULT 1,
    "reprintOf" TEXT,
    "requestedBy" TEXT,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "resultAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "station_print_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "station_print_jobs_stationId_status_idx" ON "station_print_jobs"("stationId", "status");
CREATE INDEX IF NOT EXISTS "station_print_jobs_displayId_createdAt_idx" ON "station_print_jobs"("displayId", "createdAt");
DO $$ BEGIN ALTER TABLE "station_print_jobs" ADD CONSTRAINT "station_print_jobs_displayId_fkey"
  FOREIGN KEY ("displayId") REFERENCES "station_displays"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "station_print_jobs" ADD CONSTRAINT "station_print_jobs_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Operator → station messages.
CREATE TABLE IF NOT EXISTS "station_display_messages" (
    "id" TEXT NOT NULL,
    "displayId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "requireAck" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "station_display_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "station_display_messages_displayId_acknowledgedAt_idx" ON "station_display_messages"("displayId", "acknowledgedAt");
DO $$ BEGIN ALTER TABLE "station_display_messages" ADD CONSTRAINT "station_display_messages_displayId_fkey"
  FOREIGN KEY ("displayId") REFERENCES "station_displays"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
