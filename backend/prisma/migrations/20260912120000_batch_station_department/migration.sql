-- AlterEnum
-- AYROVI Batch (owner order 2026-09-12): the batch lane becomes a REAL
-- station department with its own stations (BATCH-01), created and managed
-- from the admin Stations page — not from seeds.
ALTER TYPE "StationDepartment" ADD VALUE 'BATCH';
