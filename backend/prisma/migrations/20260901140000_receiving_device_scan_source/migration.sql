-- Receiving terminal: device & scan-source support.
--
-- Adds the physical input source of a scan (camera / external scanner /
-- manual) and lightweight device context on the receiving session. The
-- receiving workflow is identical regardless of source; this records WHERE a
-- value came from for auditing, diagnostics and device analytics only.

-- CreateEnum
CREATE TYPE "ScanSource" AS ENUM ('CAMERA', 'EXTERNAL_SCANNER', 'MANUAL');

-- AlterTable: record the input source per carton scan.
ALTER TABLE "receiving_cartons" ADD COLUMN "source" "ScanSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable: device context of the terminal that started the session.
ALTER TABLE "receiving_sessions"
  ADD COLUMN "deviceType"  TEXT,
  ADD COLUMN "deviceName"  TEXT,
  ADD COLUMN "scanSource"  TEXT;
