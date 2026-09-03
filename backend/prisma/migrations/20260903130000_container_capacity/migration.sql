-- COMMAND #1 FINAL — Receiving Container / Tote capacity as configurable
-- master data (default 50, never hardcoded). FULL is derived from the
-- live article count vs this column. Guarded and additive.
ALTER TABLE "operational_containers" ADD COLUMN IF NOT EXISTS "capacity" INTEGER NOT NULL DEFAULT 50;
