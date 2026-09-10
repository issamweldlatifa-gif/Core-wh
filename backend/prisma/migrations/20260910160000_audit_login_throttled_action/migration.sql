-- Per-account brute-force lock audit action (LoginThrottleService,
-- auth.service USER_LOGIN_THROTTLED). Additive enum value; safe on PG 12+.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_LOGIN_THROTTLED';
