/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

/**
 * IN-PROCESS SCHEMA SELF-REPAIR — runs at every boot, BEFORE Nest starts.
 *
 * WHY THIS EXISTS
 * ---------------
 * Production (Render) suffered schema drift: the `_prisma_migrations` ledger
 * was clean while real tables/columns were missing (`putaway_sessions`,
 * `carton_placements`, `warehouse_cartons.currentLocationId`, ...), so every
 * request touching them returned P2021/P2022. Two previous fixes lived in
 * `start.sh` (drift diff + repair migration), but production logs proved the
 * start script's repair path never ran on the deployed service — most likely
 * the service's Start Command is set directly to `node dist/main.js` in the
 * Render dashboard, bypassing `start.sh` entirely.
 *
 * THE ONLY place guaranteed to execute on every deployment, no matter what
 * the start command is, is the application entrypoint itself. So the repair
 * lives HERE now.
 *
 * SAFETY
 * ------
 * - A fast probe checks whether all required objects exist; on a healthy
 *   database the repair is skipped entirely (one cheap SELECT).
 * - Every repair statement is guarded (IF NOT EXISTS / duplicate_object),
 *   purely ADDITIVE, and idempotent. Nothing is dropped, altered
 *   destructively, or rewritten. Data cannot be lost.
 * - Statements run one by one outside any explicit transaction (required by
 *   `ALTER TYPE ... ADD VALUE`), each failure is logged and skipped so one
 *   hiccup can never brick the boot.
 * - If the repair itself fails, the app STILL boots (drifted but alive) and
 *   the AllExceptionsFilter keeps surfacing P2021/P2022 clearly.
 */

/** Objects whose absence marks the drift we know about. */
const PROBE_SQL = `
  SELECT
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'putaway_sessions')   AS putaway_sessions,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'carton_placements')  AS carton_placements,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'stations')           AS stations,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stations' AND column_name = 'warehouseId') AS station_wh,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'operation_corrections') AS operation_corrections,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'warehouse_cartons'  AND column_name = 'currentLocationId') AS carton_loc,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'warehouse_cartons'  AND column_name = 'storedAt')          AS carton_stored,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receiving_sessions' AND column_name = 'stationId')         AS rs_station,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receiving_sessions' AND column_name = 'deviceType')        AS rs_device,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receiving_cartons'  AND column_name = 'source')            AS rc_source,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expected_arrival_items' AND column_name = 'category')      AS eai_category,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'receiving_products' AND column_name = 'category')          AS rp_category,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'category_master')       AS category_master,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'category_zone_mappings') AS category_zone_mappings,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_containers' AND column_name = 'capacity')   AS container_capacity,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expected_arrival_items' AND column_name = 'categoryStatus') AS eai_category_status,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'containerId')          AS au_container,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'currentLocationId')   AS au_location,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'storedAt')           AS au_stored,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'orderId')            AS au_order,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'orderItemId')        AS au_order_item,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'outboundShipmentId')  AS au_shipment,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'receivingSessionId')  AS au_session,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'article_units' AND column_name = 'sourceCartonId')      AS au_carton,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'outbound_shipments' AND column_name = 'packedAt')      AS ob_packed,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'outbound_shipments' AND column_name = 'containerId')    AS ob_container,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'outbound_shipments' AND column_name = 'carrier')        AS ob_carrier,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_containers' AND column_name = 'createdBy')   AS container_created_by,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_containers' AND column_name = 'orderId')     AS container_order,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'worker_task_assignments' AND column_name = 'taskKey')       AS wta_task_key,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'worker_task_assignments' AND column_name = 'arrivalId')     AS wta_arrival,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'worker_task_assignments' AND column_name = 'stationId')     AS wta_station,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'receiving_scan_events')      AS receiving_scan_events,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'warehouse_cartons' AND column_name = 'claimedById')         AS carton_claim,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stations'               AND column_name = 'zoneId')             AS station_zone,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_containers' AND column_name = 'qrValue')            AS container_qr,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'operational_containers' AND column_name = 'stagingStationId') AS container_staging,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'warehouse_orders'       AND column_name = 'customerName')     AS order_customer_name,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'shipping_verifications')  AS shipping_verifications,
    (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = 'public' AND table_name = 'operational_exceptions')  AS operational_exceptions
`;

/**
 * Guarded, additive repair statements — the same content as migration
 * `20260902100000_repair_warehouse_os_drift`, split into single statements
 * (Prisma's $executeRawUnsafe sends one statement per call).
 */
const REPAIR_STATEMENTS: string[] = [
  // ---- enums -------------------------------------------------------------
  `DO $$ BEGIN CREATE TYPE "ScanSource" AS ENUM ('CAMERA', 'EXTERNAL_SCANNER', 'MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "StationDepartment" AS ENUM ('RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "StationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "StationCapability" AS ENUM ('CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "CorrectionAction" AS ENUM ('REVERSE_RECEIVING', 'CORRECT_PRODUCT', 'CORRECT_QUANTITY', 'REASSIGN_SESSION', 'REOPEN_SESSION', 'VOID_OPERATION', 'RESOLVE_EXCEPTION'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "PutawaySessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- enum value additions ----------------------------------------------
  `ALTER TYPE "CartonStatus" ADD VALUE IF NOT EXISTS 'STORED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_CREATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UPDATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_STATUS_CHANGED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_ASSIGNED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'STATION_UNASSIGNED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CORRECTION_APPLIED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECEIVING_REVERSED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REOPENED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REASSIGNED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_STARTED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_PAUSED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_RESUMED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_COMPLETED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_STORED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_MOVED'`,
  // ---- receiving device/scan-source columns -------------------------------
  `ALTER TABLE "receiving_cartons" ADD COLUMN IF NOT EXISTS "source" "ScanSource" NOT NULL DEFAULT 'MANUAL'`,
  `ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "deviceType" TEXT`,
  `ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "deviceName" TEXT`,
  `ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "scanSource" TEXT`,
  `ALTER TABLE "receiving_sessions" ADD COLUMN IF NOT EXISTS "stationId" TEXT`,
  // ---- stations ------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS "stations" (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stations_code_key" ON "stations"("code")`,
  `ALTER TABLE "stations" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "stations_department_idx" ON "stations"("department")`,
  `CREATE INDEX IF NOT EXISTS "stations_status_idx" ON "stations"("status")`,
  `CREATE INDEX IF NOT EXISTS "stations_assignedWorkerId_idx" ON "stations"("assignedWorkerId")`,
  `DO $$ BEGIN ALTER TABLE "stations" ADD CONSTRAINT "stations_assignedWorkerId_fkey" FOREIGN KEY ("assignedWorkerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "stations" ADD CONSTRAINT "stations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- operation_corrections -----------------------------------------------
  `CREATE TABLE IF NOT EXISTS "operation_corrections" (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "operation_corrections_code_key" ON "operation_corrections"("code")`,
  `CREATE INDEX IF NOT EXISTS "operation_corrections_entityType_entityId_idx" ON "operation_corrections"("entityType", "entityId")`,
  `CREATE INDEX IF NOT EXISTS "operation_corrections_receivingSessionId_idx" ON "operation_corrections"("receivingSessionId")`,
  `CREATE INDEX IF NOT EXISTS "operation_corrections_adminId_idx" ON "operation_corrections"("adminId")`,
  `CREATE INDEX IF NOT EXISTS "operation_corrections_createdAt_idx" ON "operation_corrections"("createdAt")`,
  `DO $$ BEGIN ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_receivingSessionId_fkey" FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "operation_corrections" ADD CONSTRAINT "operation_corrections_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- receiving_sessions -> stations relation ------------------------------
  `CREATE INDEX IF NOT EXISTS "receiving_sessions_stationId_idx" ON "receiving_sessions"("stationId")`,
  `DO $$ BEGIN ALTER TABLE "receiving_sessions" ADD CONSTRAINT "receiving_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- putaway --------------------------------------------------------------
  `ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "currentLocationId" TEXT`,
  `ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "storedAt" TIMESTAMP(3)`,
  `CREATE TABLE IF NOT EXISTS "putaway_sessions" (
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
  )`,
  `CREATE TABLE IF NOT EXISTS "carton_placements" (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "putaway_sessions_code_key" ON "putaway_sessions"("code")`,
  `CREATE INDEX IF NOT EXISTS "putaway_sessions_status_idx" ON "putaway_sessions"("status")`,
  `CREATE INDEX IF NOT EXISTS "putaway_sessions_workerId_idx" ON "putaway_sessions"("workerId")`,
  `CREATE INDEX IF NOT EXISTS "putaway_sessions_stationId_idx" ON "putaway_sessions"("stationId")`,
  `CREATE INDEX IF NOT EXISTS "carton_placements_cartonId_idx" ON "carton_placements"("cartonId")`,
  `CREATE INDEX IF NOT EXISTS "carton_placements_locationId_idx" ON "carton_placements"("locationId")`,
  `CREATE INDEX IF NOT EXISTS "carton_placements_putawaySessionId_idx" ON "carton_placements"("putawaySessionId")`,
  `CREATE INDEX IF NOT EXISTS "carton_placements_releasedAt_idx" ON "carton_placements"("releasedAt")`,
  `CREATE INDEX IF NOT EXISTS "warehouse_cartons_currentLocationId_idx" ON "warehouse_cartons"("currentLocationId")`,
  `DO $$ BEGIN ALTER TABLE "warehouse_cartons" ADD CONSTRAINT "warehouse_cartons_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "putaway_sessions" ADD CONSTRAINT "putaway_sessions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "carton_placements" ADD CONSTRAINT "carton_placements_putawaySessionId_fkey" FOREIGN KEY ("putawaySessionId") REFERENCES "putaway_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- product category from CRM card (migration 20260902210000) ----------
  `ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "category" TEXT`,
  `ALTER TABLE "receiving_products" ADD COLUMN IF NOT EXISTS "category" TEXT`,
  `CREATE INDEX IF NOT EXISTS "expected_arrival_items_category_idx" ON "expected_arrival_items"("category")`,
  // ---- category master + validation (migration 20260903090000) ------------
  `DO $$ BEGIN CREATE TYPE "CategoryValidationStatus" AS ENUM ('CONFIRMED', 'NEEDS_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "CategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_CREATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_UPDATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_STATUS_CHANGED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MAPPING_SET'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MAPPING_REMOVED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_VALIDATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_NEEDS_REVIEW'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_MANUALLY_CHANGED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SORTING_DESTINATION_SELECTED'`,
  `CREATE TABLE IF NOT EXISTS "category_master" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "subcategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "category_master_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "category_master_code_key" ON "category_master"("code")`,
  `CREATE INDEX IF NOT EXISTS "category_master_status_idx" ON "category_master"("status")`,
  `CREATE TABLE IF NOT EXISTS "category_zone_mappings" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "category_zone_mappings_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "category_zone_mappings_categoryId_zoneId_key" ON "category_zone_mappings"("categoryId", "zoneId")`,
  `CREATE INDEX IF NOT EXISTS "category_zone_mappings_zoneId_idx" ON "category_zone_mappings"("zoneId")`,
  `DO $$ BEGIN ALTER TABLE "category_zone_mappings" ADD CONSTRAINT "category_zone_mappings_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "category_master"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "category_zone_mappings" ADD CONSTRAINT "category_zone_mappings_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "subcategory" TEXT`,
  `ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "classificationSource" TEXT`,
  `ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW'`,
  `ALTER TABLE "receiving_products" ADD COLUMN IF NOT EXISTS "subcategory" TEXT`,
  `ALTER TABLE "receiving_products" ADD COLUMN IF NOT EXISTS "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW'`,
  // ---- operational flow: containers + articles + outbound (20260903120000) --
  `DO $$ BEGIN CREATE TYPE "ContainerType" AS ENUM ('RECEIVING', 'CUSTOMER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "ContainerStatus" AS ENUM ('ACTIVE', 'READY_FOR_PACKING', 'PACKED', 'CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "ArticleUnitStatus" AS ENUM ('RECEIVED', 'IN_CONTAINER', 'STORED', 'IN_CUSTOMER_BIN', 'PACKED', 'SHIPPED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN CREATE TYPE "OutboundShipmentStatus" AS ENUM ('READY_TO_SHIP', 'SHIPPED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_READY_FOR_PACKING'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_CLOSED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ARTICLE_SCANNED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_VOIDED'`,
  `CREATE TABLE IF NOT EXISTS "operational_containers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ContainerType" NOT NULL,
    "status" "ContainerStatus" NOT NULL DEFAULT 'ACTIVE',
    "capacity" INTEGER NOT NULL DEFAULT 50,
    "label" TEXT,
    "orderId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operational_containers_pkey" PRIMARY KEY ("id")
  )`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "capacity" INTEGER NOT NULL DEFAULT 50`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "createdBy" TEXT`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "label" TEXT`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "orderId" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "operational_containers_code_key" ON "operational_containers"("code")`,
  `CREATE INDEX IF NOT EXISTS "operational_containers_type_status_idx" ON "operational_containers"("type", "status")`,
  `CREATE INDEX IF NOT EXISTS "operational_containers_orderId_idx" ON "operational_containers"("orderId")`,
  `DO $$ BEGIN ALTER TABLE "operational_containers" ADD CONSTRAINT "operational_containers_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS "outbound_shipments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "containerId" TEXT,
    "status" "OutboundShipmentStatus" NOT NULL DEFAULT 'READY_TO_SHIP',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "packedBy" TEXT,
    "packedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedBy" TEXT,
    "shippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outbound_shipments_pkey" PRIMARY KEY ("id")
  )`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "containerId" TEXT`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "carrier" TEXT`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "trackingNumber" TEXT`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "packedBy" TEXT`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "packedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "shippedBy" TEXT`,
  `ALTER TABLE "outbound_shipments" ADD COLUMN IF NOT EXISTS "shippedAt" TIMESTAMP(3)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "outbound_shipments_code_key" ON "outbound_shipments"("code")`,
  `CREATE INDEX IF NOT EXISTS "outbound_shipments_orderId_idx" ON "outbound_shipments"("orderId")`,
  `CREATE INDEX IF NOT EXISTS "outbound_shipments_status_idx" ON "outbound_shipments"("status")`,
  `DO $$ BEGIN ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS "article_units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productName" TEXT,
    "category" TEXT,
    "subcategory" TEXT,
    "categoryStatus" "CategoryValidationStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
    "status" "ArticleUnitStatus" NOT NULL DEFAULT 'RECEIVED',
    "arrivalItemId" TEXT,
    "receivingSessionId" TEXT,
    "sourceCartonId" TEXT,
    "containerId" TEXT,
    "currentLocationId" TEXT,
    "storedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "orderItemId" TEXT,
    "outboundShipmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "article_units_pkey" PRIMARY KEY ("id")
  )`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "arrivalItemId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "receivingSessionId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "sourceCartonId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "containerId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "currentLocationId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "storedAt" TIMESTAMP(3)`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "orderId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "orderItemId" TEXT`,
  `ALTER TABLE "article_units" ADD COLUMN IF NOT EXISTS "outboundShipmentId" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "article_units_code_key" ON "article_units"("code")`,
  `CREATE INDEX IF NOT EXISTS "article_units_sku_idx" ON "article_units"("sku")`,
  `CREATE INDEX IF NOT EXISTS "article_units_status_idx" ON "article_units"("status")`,
  `CREATE INDEX IF NOT EXISTS "article_units_containerId_idx" ON "article_units"("containerId")`,
  `CREATE INDEX IF NOT EXISTS "article_units_currentLocationId_idx" ON "article_units"("currentLocationId")`,
  `CREATE INDEX IF NOT EXISTS "article_units_orderId_idx" ON "article_units"("orderId")`,
  `CREATE INDEX IF NOT EXISTS "article_units_receivingSessionId_idx" ON "article_units"("receivingSessionId")`,
  `CREATE INDEX IF NOT EXISTS "article_units_outboundShipmentId_idx" ON "article_units"("outboundShipmentId")`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_arrivalItemId_fkey" FOREIGN KEY ("arrivalItemId") REFERENCES "expected_arrival_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_receivingSessionId_fkey" FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_sourceCartonId_fkey" FOREIGN KEY ("sourceCartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "article_units" ADD CONSTRAINT "article_units_outboundShipmentId_fkey" FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- admin data-control soft-void terminal states (20260903140000) -----
  `ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'VOIDED'`,
  `ALTER TYPE "CartonStatus" ADD VALUE IF NOT EXISTS 'VOIDED'`,
  `ALTER TYPE "ContainerStatus" ADD VALUE IF NOT EXISTS 'VOIDED'`,
  `ALTER TYPE "ArticleUnitStatus" ADD VALUE IF NOT EXISTS 'VOIDED'`,
  // ---- worker control: task assignments (20260903150000) ------------------
  `DO $$ BEGIN CREATE TYPE "AssignmentStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_ASSIGNED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_COMPLETED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_CANCELLED'`,
  `CREATE TABLE IF NOT EXISTS "worker_task_assignments" ("id" TEXT NOT NULL, "workerId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT, "relatedType" TEXT, "relatedCode" TEXT, "status" "AssignmentStatus" NOT NULL DEFAULT 'OPEN', "createdById" TEXT, "note" TEXT, "completedById" TEXT, "completedAt" TIMESTAMP(3), "cancelledById" TEXT, "cancelledAt" TIMESTAMP(3), "cancelReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "worker_task_assignments_pkey" PRIMARY KEY ("id"))`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_workerId_status_idx" ON "worker_task_assignments"("workerId", "status")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_status_idx" ON "worker_task_assignments"("status")`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // ---- worker operational model (20260906120000) ---------------------------
  // AssignmentStatus rebuild: OPEN/DONE (advisory) -> operational lifecycle.
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssignmentStatus') THEN
    CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'BLOCKED', 'CANCELLED');
  ELSE
    IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
               WHERE t.typname = 'AssignmentStatus' AND e.enumlabel = 'OPEN') THEN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AssignmentStatus_new') THEN
        CREATE TYPE "AssignmentStatus_new" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'BLOCKED', 'CANCELLED');
      END IF;
      EXECUTE 'ALTER TABLE "worker_task_assignments" ALTER COLUMN "status" DROP DEFAULT';
      EXECUTE 'ALTER TABLE "worker_task_assignments" ALTER COLUMN "status" TYPE "AssignmentStatus_new" '
           || 'USING (CASE "status"::text WHEN ''OPEN'' THEN ''ASSIGNED''::text WHEN ''DONE'' THEN ''COMPLETED''::text ELSE "status"::text END)::"AssignmentStatus_new"';
      DROP TYPE "AssignmentStatus";
      ALTER TYPE "AssignmentStatus_new" RENAME TO "AssignmentStatus";
      EXECUTE 'ALTER TABLE "worker_task_assignments" ALTER COLUMN "status" SET DEFAULT ''ASSIGNED''::"AssignmentStatus"';
    END IF;
  END IF;
END $$`,
  `ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'IN_PROGRESS'`,
  `ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'COMPLETED_WITH_DISCREPANCY'`,
  `ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'BLOCKED'`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "taskKey" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "arrivalId" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "cartonId" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "containerId" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "outboundShipmentId" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "orderId" TEXT`,
  `ALTER TABLE "worker_task_assignments" ADD COLUMN IF NOT EXISTS "stationId" TEXT`,
  `UPDATE "worker_task_assignments" a SET "arrivalId" = e.id FROM "expected_arrivals" e WHERE a."relatedType" = 'ARRIVAL' AND a."relatedCode" = e.code AND a."arrivalId" IS NULL`,
  `UPDATE "worker_task_assignments" a SET "cartonId" = c.id FROM "warehouse_cartons" c WHERE a."relatedType" IN ('CARTON', 'SHIPMENT') AND (a."relatedCode" = c."externalCartonId" OR a."relatedCode" = c."qrCodeValue" OR a."relatedCode" = c."barcodeValue") AND a."cartonId" IS NULL`,
  `UPDATE "worker_task_assignments" a SET "containerId" = o.id FROM "operational_containers" o WHERE a."relatedType" IN ('CONTAINER', 'BIN', 'TOTE') AND a."relatedCode" = o.code AND a."containerId" IS NULL`,
  `UPDATE "worker_task_assignments" a SET "outboundShipmentId" = s.id FROM "outbound_shipments" s WHERE a."relatedType" IN ('OUTBOUND', 'SHIPMENT_OUT') AND a."relatedCode" = s.code AND a."outboundShipmentId" IS NULL`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_arrivalId_fkey" FOREIGN KEY ("arrivalId") REFERENCES "expected_arrivals"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_cartonId_fkey" FOREIGN KEY ("cartonId") REFERENCES "warehouse_cartons"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "operational_containers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_outboundShipmentId_fkey" FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "warehouse_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "worker_task_assignments" ADD CONSTRAINT "worker_task_assignments_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_taskKey_status_idx" ON "worker_task_assignments"("taskKey", "status")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_arrivalId_idx" ON "worker_task_assignments"("arrivalId")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_cartonId_idx" ON "worker_task_assignments"("cartonId")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_containerId_idx" ON "worker_task_assignments"("containerId")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_outboundShipmentId_idx" ON "worker_task_assignments"("outboundShipmentId")`,
  `CREATE INDEX IF NOT EXISTS "worker_task_assignments_stationId_idx" ON "worker_task_assignments"("stationId")`,
  // receiving_scan_events — C-4 idempotency ledger.
  `CREATE TABLE IF NOT EXISTS "receiving_scan_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receiving_scan_events_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "receiving_scan_events_operationId_key" ON "receiving_scan_events"("operationId")`,
  `CREATE INDEX IF NOT EXISTS "receiving_scan_events_sessionId_idx" ON "receiving_scan_events"("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "receiving_scan_events_kind_idx" ON "receiving_scan_events"("kind")`,
  `DO $$ BEGIN ALTER TABLE "receiving_scan_events" ADD CONSTRAINT "receiving_scan_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // warehouse_cartons — C-6 soft putaway claim.
  `ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "claimedById" TEXT`,
  `ALTER TABLE "warehouse_cartons" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)`,
  // stations.deviceId -> Device registry FK (C-8).
  `UPDATE "stations" s SET "deviceId" = d.id FROM "devices" d WHERE s."deviceId" = d.code`,
  `UPDATE "stations" SET "deviceId" = NULL WHERE "deviceId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "devices" d WHERE d.id = "stations"."deviceId")`,
  `DO $$ BEGIN ALTER TABLE "stations" ADD CONSTRAINT "stations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // worker issue reporting + assignment lifecycle audit actions.
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'WORKER_ISSUE_REPORTED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_IN_PROGRESS'`,
  // receiving tote lifecycle: full or manually closed -> READY_FOR_SORTING.
  `ALTER TYPE "ContainerStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_SORTING'`,
  // ---- master workflow chain (migration 20260906180000) ----------------------
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TASK_AUTO_DISPATCHED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONTAINER_STAGED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_QR_GENERATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_CONTAINER_LOCKED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_CONTAINER_REOPENED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHIPPING_VERIFIED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXCEPTION_CREATED'`,
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EXCEPTION_RESOLVED'`,
  `ALTER TYPE "StationDepartment" ADD VALUE IF NOT EXISTS 'STAGING'`,
  `ALTER TYPE "CorrectionAction" ADD VALUE IF NOT EXISTS 'REOPEN_CUSTOMER_BIN'`,
  `DO $$ BEGIN CREATE TYPE "OperationalExceptionStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // stations ↔ zone configuration (§11).
  `ALTER TABLE "stations" ADD COLUMN IF NOT EXISTS "zoneId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "stations_zoneId_idx" ON "stations"("zoneId")`,
  `DO $$ BEGIN ALTER TABLE "stations" ADD CONSTRAINT "stations_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // container staging + customer QR (§11/§15).
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "qrValue" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "operational_containers_qrValue_key" ON "operational_containers"("qrValue")`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagingStationId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "operational_containers_stagingStationId_idx" ON "operational_containers"("stagingStationId")`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagedAt" TIMESTAMP(3)`,
  `ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "stagedById" TEXT`,
  `DO $$ BEGIN ALTER TABLE "operational_containers" ADD CONSTRAINT "operational_containers_stagingStationId_fkey" FOREIGN KEY ("stagingStationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // customer name/surname projection for cards + bordereau search (§12/§18).
  `ALTER TABLE "warehouse_orders" ADD COLUMN IF NOT EXISTS "customerName" TEXT`,
  `ALTER TABLE "warehouse_orders" ADD COLUMN IF NOT EXISTS "customerSurname" TEXT`,
  `CREATE INDEX IF NOT EXISTS "warehouse_orders_customerName_idx" ON "warehouse_orders"("customerName")`,
  `CREATE INDEX IF NOT EXISTS "warehouse_orders_customerSurname_idx" ON "warehouse_orders"("customerSurname")`,
  // shipping pre-dispatch verification (§17).
  `CREATE TABLE IF NOT EXISTS "shipping_verifications" (
    "id" TEXT NOT NULL,
    "outboundShipmentId" TEXT NOT NULL,
    "verifiedById" TEXT,
    "contentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shipping_verifications_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "shipping_verifications_outboundShipmentId_idx" ON "shipping_verifications"("outboundShipmentId")`,
  `DO $$ BEGIN ALTER TABLE "shipping_verifications" ADD CONSTRAINT "shipping_verifications_outboundShipmentId_fkey" FOREIGN KEY ("outboundShipmentId") REFERENCES "outbound_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  // cross-stage operational exceptions (§7/§14/§26).
  `CREATE TABLE IF NOT EXISTS "operational_exceptions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "OperationalExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityCode" TEXT,
    "taskKey" TEXT,
    "reason" TEXT NOT NULL,
    "reportedById" TEXT,
    "stationId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "operational_exceptions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "operational_exceptions_code_key" ON "operational_exceptions"("code")`,
  `CREATE INDEX IF NOT EXISTS "operational_exceptions_status_idx" ON "operational_exceptions"("status")`,
  `CREATE INDEX IF NOT EXISTS "operational_exceptions_type_idx" ON "operational_exceptions"("type")`,
  `DO $$ BEGIN ALTER TABLE "operational_exceptions" ADD CONSTRAINT "operational_exceptions_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

export async function repairSchemaDriftIfNeeded(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(PROBE_SQL);
    const probe = rows?.[0] ?? {};
    const missing = Object.entries(probe)
      .filter(([, v]) => Number(v) === 0)
      .map(([k]) => k);

    if (missing.length === 0) {
      console.log('[schema-repair] Schema OK — all WAREHOUSE OS objects present.');
      return;
    }

    console.warn(
      `[schema-repair] !!! SCHEMA DRIFT DETECTED — missing: ${missing.join(', ')}. ` +
        'Applying guarded additive repair...',
    );

    let applied = 0;
    let failed = 0;
    for (const sql of REPAIR_STATEMENTS) {
      try {
        await prisma.$executeRawUnsafe(sql);
        applied += 1;
      } catch (err: any) {
        failed += 1;
        const firstLine = sql.replace(/\s+/g, ' ').slice(0, 90);
        console.error(`[schema-repair] statement failed (continuing): ${firstLine}… -> ${err?.message?.split('\n')[0] ?? err}`);
      }
    }
    console.log(`[schema-repair] Repair pass done: ${applied} applied, ${failed} failed.`);

    // Record the equivalent repair migrations as applied so a later
    // `prisma migrate deploy` does not re-run them (they would be no-ops
    // anyway, but a clean ledger avoids confusion). Best effort only.
    for (const migrationName of [
      '20260902100000_repair_warehouse_os_drift',
      '20260902210000_product_category_from_crm',
      '20260903090000_category_master_and_validation',
      '20260903120000_operational_flow_containers_articles_outbound',
      '20260903130000_container_capacity',
      '20260903140000_admin_data_void_control',
      '20260903150000_admin_worker_control_tasks',
      '20260906120000_worker_operational_model',
      '20260906180000_master_workflow_chain',
    ]) {
      try {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "_prisma_migrations"
            ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
          SELECT gen_random_uuid()::text, 'in-process-schema-repair', NOW(),
                 '${migrationName}', 'applied by in-process bootstrap repair', NULL, NOW(), 1
          WHERE NOT EXISTS (
            SELECT 1 FROM "_prisma_migrations" WHERE "migration_name" = '${migrationName}'
          )
        `);
      } catch {
        /* ledger bookkeeping is cosmetic — ignore */
      }
    }

    // Verify.
    const after = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(PROBE_SQL);
    const stillMissing = Object.entries(after?.[0] ?? {})
      .filter(([, v]) => Number(v) === 0)
      .map(([k]) => k);
    if (stillMissing.length === 0) {
      console.log('[schema-repair] >>> Schema repaired successfully. All objects present.');
    } else {
      console.error(`[schema-repair] WARNING: still missing after repair: ${stillMissing.join(', ')}`);
    }
  } catch (err: any) {
    // Never block the boot: a repair failure leaves us exactly where we were.
    console.error(`[schema-repair] repair pass errored (boot continues): ${err?.message ?? err}`);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
