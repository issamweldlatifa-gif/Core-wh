-- COMMAND #2 (user) — Admin Data Control: soft-void terminal states.
-- Additive enum values only; no data is moved or dropped.
-- Guards make this re-runnable (idempotent) exactly like every migration in
-- this repo; the same statements are mirrored by the in-process boot repair.

ALTER TYPE "ExpectedArrivalStatus" ADD VALUE IF NOT EXISTS 'VOIDED';
ALTER TYPE "CartonStatus" ADD VALUE IF NOT EXISTS 'VOIDED';
ALTER TYPE "ContainerStatus" ADD VALUE IF NOT EXISTS 'VOIDED';
ALTER TYPE "ArticleUnitStatus" ADD VALUE IF NOT EXISTS 'VOIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_VOIDED';
