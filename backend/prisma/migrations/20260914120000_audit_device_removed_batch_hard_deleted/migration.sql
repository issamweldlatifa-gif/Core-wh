-- OWNER 2026-09-14: admin device removal + batch hard delete audit actions.
-- Additive enum values; safe on PG 12+ (same pattern as the
-- audit_login_throttled_action migration).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DEVICE_REMOVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BATCH_HARD_DELETED';
