-- MASTER EXECUTION — Temporary Storage becomes a REAL link in the reference
-- chain (Receiving -> Temporary Storage -> Sorting -> Packing -> Shipping).
--
-- 1) Every placed unit materializes a real ArticleUnit; the placement row
--    keeps the link so the sorting/packing/shipping operations work on the
--    same physical unit the storage agent put away.
ALTER TABLE "temporary_storage_items" ADD COLUMN IF NOT EXISTS "articleUnitId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "temporary_storage_items_articleUnitId_key"
  ON "temporary_storage_items"("articleUnitId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'temporary_storage_items_articleUnitId_fkey'
      AND table_name = 'temporary_storage_items'
  ) THEN
    ALTER TABLE "temporary_storage_items"
      ADD CONSTRAINT "temporary_storage_items_articleUnitId_fkey"
      FOREIGN KEY ("articleUnitId") REFERENCES "article_units"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 2) The "Agent de tri" (Sorting, TRI PAR CLIENT) works on CUSTOMER
--    containers: the sorting worker role must therefore hold the picking
--    permissions used by the order-sorting (customer container) lane.
INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('picking.view', 'picking.execute')
WHERE r.name = 'SORTING_WORKER'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
