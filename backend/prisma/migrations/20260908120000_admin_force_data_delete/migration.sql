-- Admin Force Data Delete (PART 4) — emergency cleanup of data that is already
-- ACTIVE/OPEN inside the worker workflow.
--
-- Additive enum value only; no table, column or row is touched. The audit
-- trail keeps every FORCE_DELETE forever, so the action is fully traceable
-- even though the operational rows it targets are removed/cancelled.
-- Guarded to stay re-runnable (idempotent), like every migration in this repo;
-- the same statement is mirrored by the in-process boot repair.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_FORCE_DELETED';
