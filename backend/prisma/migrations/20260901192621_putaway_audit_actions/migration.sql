-- Audit verbs for the stowing workflow.
-- `IF NOT EXISTS` keeps each ADD VALUE idempotent so a re-applied migration
-- cannot fail (see 20260901175952 for the incident this protects against).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_PAUSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PUTAWAY_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_STORED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ITEM_MOVED';
