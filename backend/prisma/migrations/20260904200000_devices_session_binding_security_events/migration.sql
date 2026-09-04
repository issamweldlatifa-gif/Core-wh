-- Strict Admin/Worker isolation — device registry + session binding + security events.

-- 1) Device status enum + device table --------------------------------------
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "model" TEXT,
    "appVersion" TEXT,
    "stationCode" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "assignedWorkerId" TEXT,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "devices_code_key" ON "devices"("code");
CREATE INDEX "devices_status_idx" ON "devices"("status");
CREATE INDEX "devices_assignedWorkerId_idx" ON "devices"("assignedWorkerId");

ALTER TABLE "devices" ADD CONSTRAINT "devices_assignedWorkerId_fkey"
    FOREIGN KEY ("assignedWorkerId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Bind sessions to an authorized device + assigned station --------------
ALTER TABLE "sessions" ADD COLUMN "deviceId" TEXT;
ALTER TABLE "sessions" ADD COLUMN "stationId" TEXT;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "devices"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_stationId_fkey"
    FOREIGN KEY ("stationId") REFERENCES "stations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "sessions_deviceId_idx" ON "sessions"("deviceId");
CREATE INDEX "sessions_stationId_idx" ON "sessions"("stationId");

-- 3) Security event actions ------------------------------------------------
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKER_APP_ACCESS_DENIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_APP_ACCESS_DENIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNAUTHORIZED_PERMISSION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UNAUTHORIZED_STATION_ACCESS';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_REGISTERED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_ASSIGNED';
