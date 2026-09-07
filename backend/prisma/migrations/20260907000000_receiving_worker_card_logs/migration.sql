-- Receiving receiving-worker card operations log (device-side matching rebuild).
--
-- The receiving terminal is rebuilt around two INDEPENDENT card types pushed
-- by the CRM (Product Card / Carton Card). Workers match scanned identifiers
-- against the expected card data ON THEIR DEVICE; this table is the backend's
-- persistent, auditable record of every worker card operation so the Admin
-- "Receiving Worker" report can answer: Who / What / When / Card / Card Type /
-- Operation / Identifier Type / Identifier Value / Result / Duration / Device.
--
-- Additive only: existing receiving tables and enums are untouched except the
-- two documented additive enum values below.

-- ===== Additive audit action =====
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CARD_ALREADY_COMPLETED';

-- ===== Additive scan type (operator-confirmed OCR text) =====
ALTER TYPE "ScanType" ADD VALUE IF NOT EXISTS 'OCR';

-- ===== New enums =====
CREATE TYPE "CardType" AS ENUM ('PRODUCT', 'CARTON');
CREATE TYPE "WorkerLogOperation" AS ENUM ('CONFIRM', 'SCAN_REJECT', 'DUPLICATE_REJECT');
CREATE TYPE "WorkerLogResult" AS ENUM ('MATCH', 'MISMATCH', 'DUPLICATE', 'AMBIGUOUS');

-- ===== receiving_worker_logs =====
CREATE TABLE "receiving_worker_logs" (
    "id" TEXT NOT NULL,
    "receivingSessionId" TEXT NOT NULL,
    "workerId" TEXT,
    "workerName" TEXT,
    "taskKey" TEXT NOT NULL DEFAULT 'receiving',
    "arrivalCode" TEXT,
    "sessionCode" TEXT,
    "cardType" "CardType" NOT NULL DEFAULT 'PRODUCT',
    "cardRef" TEXT,
    "operation" "WorkerLogOperation" NOT NULL,
    "identifierType" "ScanType" NOT NULL DEFAULT 'MANUAL',
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "identifierValue" TEXT NOT NULL,
    "result" "WorkerLogResult" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "deviceType" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receiving_worker_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receiving_worker_logs_receivingSessionId_idx" ON "receiving_worker_logs"("receivingSessionId");
CREATE INDEX "receiving_worker_logs_workerId_createdAt_idx" ON "receiving_worker_logs"("workerId", "createdAt");
CREATE INDEX "receiving_worker_logs_cardType_result_idx" ON "receiving_worker_logs"("cardType", "result");
CREATE INDEX "receiving_worker_logs_createdAt_idx" ON "receiving_worker_logs"("createdAt");

ALTER TABLE "receiving_worker_logs" ADD CONSTRAINT "receiving_worker_logs_receivingSessionId_fkey"
    FOREIGN KEY ("receivingSessionId") REFERENCES "receiving_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
