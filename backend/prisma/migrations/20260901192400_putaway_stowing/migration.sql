-- CreateEnum
CREATE TYPE "PutawaySessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "CartonStatus" ADD VALUE 'STORED';

-- AlterTable
ALTER TABLE "warehouse_cartons" ADD COLUMN     "currentLocationId" TEXT,
ADD COLUMN     "storedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "putaway_sessions" (
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
CREATE TABLE "carton_placements" (
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
CREATE UNIQUE INDEX "putaway_sessions_code_key" ON "putaway_sessions"("code");

-- CreateIndex
CREATE INDEX "putaway_sessions_status_idx" ON "putaway_sessions"("status");

-- CreateIndex
CREATE INDEX "putaway_sessions_workerId_idx" ON "putaway_sessions"("workerId");

-- CreateIndex
CREATE INDEX "putaway_sessions_stationId_idx" ON "putaway_sessions"("stationId");

-- CreateIndex
CREATE INDEX "carton_placements_cartonId_idx" ON "carton_placements"("cartonId");

-- CreateIndex
CREATE INDEX "carton_placements_locationId_idx" ON "carton_placements"("locationId");

-- CreateIndex
CREATE INDEX "carton_placements_putawaySessionId_idx" ON "carton_placements"("putawaySessionId");

-- CreateIndex
CREATE INDEX "carton_placements_releasedAt_idx" ON "carton_placements"("releasedAt");

-- CreateIndex
CREATE INDEX "warehouse_cartons_currentLocationId_idx" ON "warehouse_cartons"("currentLocationId");

-- AddForeignKey
ALTER TABLE "warehouse_cartons" ADD CONSTRAINT "warehouse_cartons_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_putawaySessionId_fkey" FOREIGN KEY ("putawaySessionId") REFERENCES "putaway_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
