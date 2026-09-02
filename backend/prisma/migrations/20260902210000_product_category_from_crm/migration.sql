-- CURRENT CARD + CATEGORY
-- Additive-only: the Arrival CRM now includes `category` on each product of
-- the existing Customer Arrival Card. We persist it on the expected line and
-- snapshot it onto the receiving reconciliation line. No existing column,
-- constraint, contract or idempotency key changes.
--
-- Guarded (IF NOT EXISTS) so it is safe on databases that were already
-- repaired out-of-band by the in-process bootstrap repair.

ALTER TABLE "expected_arrival_items" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "receiving_products"     ADD COLUMN IF NOT EXISTS "category" TEXT;

CREATE INDEX IF NOT EXISTS "expected_arrival_items_category_idx"
  ON "expected_arrival_items"("category");
