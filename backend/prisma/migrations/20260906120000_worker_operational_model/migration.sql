-- ============================================================================
-- WORKER OPERATIONAL MODEL — assignments linked to operational entities,
-- unit-scan idempotency ledger, putaway claims, Station→Device relation,
-- worker issue reporting audit actions.
--
-- Every statement is guarded / idempotent (repo convention since the
-- production drift incident). Safe to re-run on a partially applied DB.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) AssignmentStatus: OPEN/DONE (advisory) -> operational lifecycle.
--    Postgres cannot drop enum values, so rebuild the type and convert rows:
--      OPEN   -> ASSIGNED
--      DONE   -> COMPLETED
--      CANCELLED -> CANCELLED (unchanged)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssignmentStatus') THEN
    CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'BLOCKED', 'CANCELLED');
  ELSE
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'AssignmentStatus' AND e.enumlabel = 'OPEN') THEN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssignmentStatus_new') THEN
        CREATE TYPE "AssignmentStatus_new" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'BLOCKED', 'CANCELLED');
      END IF;
      EXECUTE 'ALTER TABLE "worker_task_assignments" ALTER COLUMN "status" TYPE "AssignmentStatus_new" '
           || 'USING (CASE "status"::text WHEN ''OPEN'' THEN ''ASSIGNED''::text WHEN ''DONE'' THEN ''COMPLETED''::text ELSE "status"::text END)::"AssignmentStatus_new"';
      DROP TYPE "AssignmentStatus";
      ALTER TYPE "AssignmentStatus_new" RENAME TO "AssignmentStatus";
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) worker_task_assignments: task registry key + authoritative entity links.
-- ---------------------------------------------------------------------------
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "taskKey" TEXT;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "arrivalId" UUID;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "cartonId" UUID;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "containerId" UUID;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "outboundShipmentId" UUID;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "orderId" UUID;
ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "stationId" UUID;

-- Backfill the FK links from the legacy relatedType/relatedCode strings, so
-- existing assignments become operationally linked instead of being dropped.
UPDATE "worker_task_assignments" a SET "arrivalId" = e.id
FROM "expected_arrivals" e
WHERE a."relatedType" = 'ARRIVAL' AND a."relatedCode" = e.code AND a."arrivalId" IS NULL;

UPDATE "worker_task_assignments" a SET "cartonId" = c.id
FROM "warehouse_cartons" c
WHERE a."relatedType" IN ('CARTON', 'SHIPMENT')
  AND (a."relatedCode" = c."externalCartonId" OR a."relatedCode" = c."qrCodeValue" OR a."relatedCode" = c."barcodeValue")
  AND a."cartonId" IS NULL;

UPDATE "worker_task_assignments" a SET "containerId" = o.id
FROM "operational_containers" o
WHERE a."relatedType" IN ('CONTAINER', 'BIN', 'TOTE') AND a."relatedCode" = o.code AND a."containerId" IS NULL;

UPDATE "worker_task_assignments" a SET "outboundShipmentId" = s.id
FROM "outbound_shipments" s
WHERE a."relatedType" IN ('OUTBOUND', 'SHIPMENT_OUT') AND a."relatedCode" = s.code AND a."outboundShipmentId" IS NULL;

-- Foreign keys (guarded).
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_arrivalId_fkey" FOREIGN KEY ("arrivalId") REFERENCES "expected_arrivals"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_outboundShipmentId_fkey" FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "worker_task_assignments_taskKey_status_idx" ON "worker_task_assignments"("taskKey", "status");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_arrivalId_idx" ON "worker_task_assignments"("arrivalId");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_cartonId_idx" ON "worker_task_assignments"("cartonId");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_containerId_idx" ON "worker_task_assignments"("containerId");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_outboundShipmentId_idx" ON "worker_task_assignments"("outboundShipmentId");
CREATE INDEX IF NOT EXISTS "worker_task_assignments_stationId_idx" ON "worker_task_assignments"("stationId");

-- ---------------------------------------------------------------------------
-- 3) receiving_scan_events — append-only idempotency ledger for unit-level
--    scans (receive-product / scan-article). One physical scan = one
--    operationId; a retried HTTP call never double-counts (fix C-4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "receiving_scan_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_scan_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "receiving_scan_events_operationId_key" ON "receiving_scan_events"("operationId");
CREATE INDEX IF NOT EXISTS "receiving_scan_events_sessionId_idx" ON "receiving_scan_events"("sessionId");
CREATE INDEX IF NOT EXISTS "receiving_scan_events_kind_idx" ON "receiving_scan_events"("kind");
DO $$ BEGIN ALTER TABLE "receiving_scan_events" ADD CONSTRAINT "receiving_scan_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 4) warehouse_cartons — soft putaway claim (fix C-6): the worker currently
--    walking this carton to a shelf. Ephemeral; cleared on placement.
-- ---------------------------------------------------------------------------
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "claimedById" TEXT;
ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 5) stations.deviceId -> real Device registry relation (fix C-8).
--    Map legacy free-text device CODES to registry ids, drop non-uuid
--    leftovers, convert the column to UUID and attach the FK.
-- ---------------------------------------------------------------------------
UPDATE "stations" s SET "deviceId" = d.id FROM "devices" d WHERE s."deviceId" = d.code;
UPDATE "stations" SET "deviceId" = NULL
WHERE "deviceId" IS NOT NULL
  AND "deviceId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
DO $$ BEGIN
  ALTER TABLE "stations" ALTER COLUMN "deviceId" TYPE UUID USING ("deviceId"::uuid);
EXCEPTION WHEN others THEN NULL; -- already uuid / not convertible — ledger migration is authoritative
END $$;
DO $$ BEGIN ALTER TABLE "stations" ADD CONSTRAINT "stations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 6) AuditAction — worker issue reporting + assignment lifecycle events.
-- ---------------------------------------------------------------------------
DO $$ BEGIN ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKER_ISSUE_REPORTED'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_IN_PROGRESS'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- ContainerStatus: READY_FOR_SORTING (receiving tote full or manually closed)
-- Guarded enum rebuild: only runs when the value is missing.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = '"ContainerStatus"'::regtype AND enumlabel = 'READY_FOR_SORTING') THEN
    ALTER TYPE "ContainerStatus" ADD VALUE 'READY_FOR_SORTING';
  END IF;
END $$;
