-- OWNER 2026-09-14: operational trial reset audit action. Additive enum
-- value; safe on PG 12+.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DATA_TRIAL_RESET';
