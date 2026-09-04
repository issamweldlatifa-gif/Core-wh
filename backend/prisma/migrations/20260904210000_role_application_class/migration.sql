-- Data-driven role classification (Doc1 §15, Doc2 §6).
-- Roles now carry an ApplicationClass in the DB so the backend never
-- classifies access by hard-coded role names.

-- 1) Enum ------------------------------------------------------------------
CREATE TYPE "ApplicationClass" AS ENUM ('ADMIN', 'OPERATIONAL', 'VIEWER', 'UNKNOWN');

-- 2) Column ----------------------------------------------------------------
ALTER TABLE "roles" ADD COLUMN "applicationClass" "ApplicationClass" NOT NULL DEFAULT 'UNKNOWN';

-- 3) Backfill the seeded system roles so existing DBs need no re-seed -------
UPDATE "roles" SET "applicationClass" = 'ADMIN'      WHERE "name" IN ('SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_MANAGER');
UPDATE "roles" SET "applicationClass" = 'OPERATIONAL' WHERE "name" IN ('INBOUND_WORKER', 'PICKER', 'PACKER');
UPDATE "roles" SET "applicationClass" = 'VIEWER'      WHERE "name" = 'VIEWER';
