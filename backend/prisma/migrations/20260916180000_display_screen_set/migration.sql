-- Station Display v3 (owner order 2026-09-16): a station gets a SET of
-- single-purpose screens (Board / Next Action / Andon / Print) instead of one
-- big screen. Additive only: one new audit action for the screen-set creation.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPLAY_SCREEN_SET_CREATED';
