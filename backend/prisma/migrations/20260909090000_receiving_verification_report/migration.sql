-- ORDER 01 — Receiving verification report (Rapport de Confirme).
-- ADDITIVE ONLY: new enums, new tables, new defaulted/nullable columns and
-- new audit actions. No renames, no drops, no changes outside Receiving.

-- New audit actions for the verification cycle.
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'DAMAGE_RECORDED';

-- Verification vocabulary (ORDER 01 statuses, receiving-scoped).
CREATE TYPE "ReceivingVerificationResult" AS ENUM ('PENDING', 'CONFIRMED', 'MISSING', 'DAMAGED');
CREATE TYPE "ReceivingReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REVIEWED', 'CLOSED');

-- Damage capture on receiving lines (DEFAULT 0: existing rows unaffected).
ALTER TABLE "receiving_products" ADD COLUMN "damagedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "receiving_products" ADD COLUMN "damageNote" TEXT;

-- Report header (one per receiving session).
CREATE TABLE "receiving_reports" (
    "id" TEXT NOT NULL,
    "receivingSessionId" TEXT NOT NULL,
    "status" "ReceivingReportStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedProducts" INTEGER NOT NULL DEFAULT 0,
    "confirmedProducts" INTEGER NOT NULL DEFAULT 0,
    "missingProducts" INTEGER NOT NULL DEFAULT 0,
    "damagedProducts" INTEGER NOT NULL DEFAULT 0,
    "expectedUnits" INTEGER NOT NULL DEFAULT 0,
    "scannedUnits" INTEGER NOT NULL DEFAULT 0,
    "confirmedUnits" INTEGER NOT NULL DEFAULT 0,
    "missingUnits" INTEGER NOT NULL DEFAULT 0,
    "damagedUnits" INTEGER NOT NULL DEFAULT 0,
    "expectedCartons" INTEGER NOT NULL DEFAULT 0,
    "receivedCartons" INTEGER NOT NULL DEFAULT 0,
    "missingCartons" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "observation" TEXT,
    "workerId" TEXT,
    "workerName" TEXT,
    "stationId" TEXT,
    "stationCode" TEXT,
    "deviceType" TEXT,
    "deviceName" TEXT,
    "submittedBy" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "handoffReadyAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receiving_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receiving_reports_receivingSessionId_key" ON "receiving_reports"("receivingSessionId");
CREATE INDEX "receiving_reports_status_idx" ON "receiving_reports"("status");

-- Per-product verification results (snapshot at submit).
CREATE TABLE "receiving_report_lines" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "receivingProductId" TEXT,
    "sku" TEXT,
    "reference" TEXT,
    "productName" TEXT,
    "expectedQuantity" INTEGER NOT NULL DEFAULT 0,
    "scannedQuantity" INTEGER NOT NULL DEFAULT 0,
    "confirmedQuantity" INTEGER NOT NULL DEFAULT 0,
    "missingQuantity" INTEGER NOT NULL DEFAULT 0,
    "damagedQuantity" INTEGER NOT NULL DEFAULT 0,
    "result" "ReceivingVerificationResult" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,

    CONSTRAINT "receiving_report_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "receiving_report_lines_reportId_idx" ON "receiving_report_lines"("reportId");
CREATE INDEX "receiving_report_lines_receivingProductId_idx" ON "receiving_report_lines"("receivingProductId");

-- Report photos (base64 data URLs; no external storage required).
CREATE TABLE "receiving_report_photos" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "lineId" TEXT,
    "dataUrl" TEXT NOT NULL,
    "caption" TEXT,
    "takenBy" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receiving_report_photos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "receiving_report_photos_reportId_idx" ON "receiving_report_photos"("reportId");

-- Foreign keys.
ALTER TABLE "receiving_reports" ADD CONSTRAINT "receiving_reports_receivingSessionId_fkey" FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receiving_report_lines" ADD CONSTRAINT "receiving_report_lines_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "receiving_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receiving_report_lines" ADD CONSTRAINT "receiving_report_lines_receivingProductId_fkey" FOREIGN KEY ("receivingProductId") REFERENCES "receiving_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receiving_report_photos" ADD CONSTRAINT "receiving_report_photos_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "receiving_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
