-- WORKFLOW SEPARATION — Carton flow vs Product flow.
-- ADDITIVE ONLY: new enums, new tables, one new nullable column.
-- No renames, no drops, no changes to existing behaviour.
--
--   CARTON FLOW : Receiving -> Verification -> Rapport Verification -> Admin -> END
--   PRODUCT FLOW: Receiving -> Temporary Storage -> Sorting -> Packing -> Ready to Shipping

-- New audit actions for the workflow separation.
ALTER TYPE "AuditAction" ADD VALUE 'WORKFLOW_CARTON_FLOW_ENDED';
ALTER TYPE "AuditAction" ADD VALUE 'WORKFLOW_GUARD_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMP_INTAKE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMP_INTAKE_STAGED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMP_INTAKE_READY_FOR_SORTING';
ALTER TYPE "AuditAction" ADD VALUE 'TEMP_INTAKE_MOVED_TO_SORTING';

-- Workflow flow discriminator + Temporary Storage intake lifecycle.
CREATE TYPE "WorkflowFlow" AS ENUM ('CARTON', 'PRODUCT');
CREATE TYPE "TempStorageIntakeStatus" AS ENUM ('RECEIVED', 'STAGED', 'READY_FOR_SORTING', 'MOVED_TO_SORTING', 'VOIDED');

-- CARTON FLOW END marker on the verification report (NULL until submit).
ALTER TABLE "receiving_reports" ADD COLUMN "cartonFlowEndedAt" TIMESTAMP(3);

-- Per-carton verification results (Output A snapshot at submit).
CREATE TABLE "receiving_report_carton_lines" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "cartonId" TEXT,
    "externalCartonId" TEXT,
    "reference" TEXT,
    "trackingNumber" TEXT,
    "expected" BOOLEAN NOT NULL DEFAULT true,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "result" "ReceivingVerificationResult" NOT NULL DEFAULT 'PENDING',
    "scannedAt" TIMESTAMP(3),
    "errorDetail" TEXT,
    "note" TEXT,

    CONSTRAINT "receiving_report_carton_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "receiving_report_carton_lines_reportId_idx" ON "receiving_report_carton_lines"("reportId");
CREATE INDEX "receiving_report_carton_lines_cartonId_idx" ON "receiving_report_carton_lines"("cartonId");

-- Append-only workflow ledger (flow transitions per item, no mixing).
CREATE TABLE "workflow_events" (
    "id" TEXT NOT NULL,
    "flow" "WorkflowFlow" NOT NULL,
    "event" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityCode" TEXT,
    "receivingSessionId" TEXT,
    "fromStation" TEXT,
    "toStation" TEXT,
    "actorId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "workflow_events_flow_event_idx" ON "workflow_events"("flow", "event");
CREATE INDEX "workflow_events_entityType_entityId_idx" ON "workflow_events"("entityType", "entityId");
CREATE INDEX "workflow_events_receivingSessionId_idx" ON "workflow_events"("receivingSessionId");
CREATE INDEX "workflow_events_createdAt_idx" ON "workflow_events"("createdAt");

-- Temporary Storage intakes (PRODUCT ONLY — no carton column by design).
CREATE TABLE "temporary_storage_intakes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "TempStorageIntakeStatus" NOT NULL DEFAULT 'RECEIVED',
    "receivingSessionId" TEXT,
    "receivingProductId" TEXT,
    "receivingReportId" TEXT,
    "receivingReportLineId" TEXT,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "verificationResult" "ReceivingVerificationResult" NOT NULL DEFAULT 'CONFIRMED',
    "stationId" TEXT,
    "zoneId" TEXT,
    "section" TEXT,
    "locationId" TEXT,
    "receivedBy" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stagedBy" TEXT,
    "stagedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "movedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temporary_storage_intakes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "temporary_storage_intakes_code_key" ON "temporary_storage_intakes"("code");
CREATE INDEX "temporary_storage_intakes_status_idx" ON "temporary_storage_intakes"("status");
CREATE INDEX "temporary_storage_intakes_receivingSessionId_idx" ON "temporary_storage_intakes"("receivingSessionId");
CREATE INDEX "temporary_storage_intakes_receivingProductId_idx" ON "temporary_storage_intakes"("receivingProductId");
CREATE INDEX "temporary_storage_intakes_stationId_idx" ON "temporary_storage_intakes"("stationId");
CREATE INDEX "temporary_storage_intakes_zoneId_idx" ON "temporary_storage_intakes"("zoneId");

-- Foreign keys.
ALTER TABLE "receiving_report_carton_lines" ADD CONSTRAINT "receiving_report_carton_lines_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "receiving_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "temporary_storage_intakes" ADD CONSTRAINT "temporary_storage_intakes_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temporary_storage_intakes" ADD CONSTRAINT "temporary_storage_intakes_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "temporary_storage_intakes" ADD CONSTRAINT "temporary_storage_intakes_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
