-- ============================================================================
-- RECONCILIATION MIGRATION — production schema drift (Render, 2026-09-03).
--
-- Incident (see deploy log):  `start.sh` detected SCHEMA DRIFT on the Render
-- PostgreSQL database and its additive self-heal (`prisma db push` WITHOUT
-- --accept-data-loss) was refused because two columns on the LIVE table
-- `stations` would need to be dropped+recreated while they are required and
-- hold data:
--
--   [*] Column `department`  would be dropped and recreated
--       (default changed from String("INBOUND"), type changed)
--   [*] Column `capabilities` would be dropped and recreated (type changed)
--
-- WHY the DB drifted: the Render database was originally created in the
-- pre-migration era with `prisma db push` against the then-current schema
-- (commit 904a63f), where
--   Station.department   = TEXT NOT NULL DEFAULT 'INBOUND'
--   Station.capabilities = TEXT[]  DEFAULT ARRAY[]::TEXT[]
-- and which also contained the legacy objects below. Later migrations were
-- generated to be purely ADDITIVE (CREATE ... IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS), so they never rewrote the pre-existing `stations` columns and
-- never removed the legacy objects. The migration ledger therefore says
-- "applied" while the live DB still differs from schema.prisma — and a
-- destructive `db push` cannot reconcile it without losing data.
--
-- The drift is the following set of pre-migration leftovers (verified by
-- reproducing this exact `prisma migrate diff` output locally):
--
--   [- ] enum   CorrectionType            (old `corrections` flow)
--   [- ] tables corrections, receiving_scan_events
--   [* ] ScanType enum contains variant OCR        (removed in current schema)
--   [* ] receiving_sessions.workerId                (superseded by startedBy/station)
--   [* ] receiving_products.operationId + unique    (superseded by carton.operationId)
--   [* ] stations.department / capabilities types   (legacy TEXT era)
--
-- WHAT THIS MIGRATION DOES (data-preserving, idempotent, re-runnable):
--   1. Archives the legacy tables + CorrectionType enum into a `legacy_archive`
--      schema instead of dropping them — no historical data is lost, and the
--      `public` schema becomes byte-identical to schema.prisma.
--   2. Backfills receiving_sessions.workerId  → startedBy before dropping the
--      obsolete column.
--   3. Casts stations.department text values onto the StationDepartment enum
--      ('INBOUND' → 'RECEIVING'; any unknown value fails loudly rather than
--      silently mis-assigning a department).
--   4. Casts stations.capabilities TEXT[] values onto StationCapability[]
--      (unknown capability fails loudly).
--   5. Rewrites the ScanType enum without the OCR variant (any archived row
--      that still says 'OCR' is remapped to 'MANUAL' first, since OCR is no
--      longer a scan-source enum member in the current model).
--   6. Re-creates stations_department_idx (dropped with the old column).
--
-- Guarded so it is a complete no-op on a healthy database. Run by `prisma
-- migrate deploy` at boot (start.sh) or manually.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisite enum types (idempotent — no-op if already present).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "StationDepartment" AS ENUM ('RECEIVING', 'SORTING', 'PUTAWAY', 'PACKING', 'INVENTORY', 'DISPATCH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "StationCapability" AS ENUM ('CAMERA', 'BARCODE_SCANNER', 'QR_SCANNER', 'OCR', 'PRINTER', 'SCALE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 1. Archive pre-migration legacy objects (public → legacy_archive).
--    No rows are deleted: the tables and their enum move whole into the
--    archive schema, out of Prisma's introspection scope.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS legacy_archive;

ALTER TABLE IF EXISTS public.corrections SET SCHEMA legacy_archive;
ALTER TABLE IF EXISTS public.receiving_scan_events SET SCHEMA legacy_archive;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'CorrectionType' AND n.nspname = 'public'
  ) THEN
    ALTER TYPE "CorrectionType" SET SCHEMA legacy_archive;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. receiving_sessions.workerId  →  startedBy (data-preserving) then drop.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receiving_sessions'
      AND column_name = 'workerId'
  ) THEN
    EXECUTE 'UPDATE receiving_sessions SET "startedBy" = "workerId"
             WHERE "startedBy" IS NULL AND "workerId" IS NOT NULL';
  END IF;
END $$;

ALTER TABLE receiving_sessions DROP COLUMN IF EXISTS "workerId";

-- ---------------------------------------------------------------------------
-- 3. receiving_products.operationId — obsolete idempotency token (cartons now
--    carry operationId). Dropping the column removes its unique index too.
-- ---------------------------------------------------------------------------
ALTER TABLE receiving_products DROP COLUMN IF EXISTS "operationId";

-- ---------------------------------------------------------------------------
-- 4. stations.department: TEXT  →  StationDepartment (data-preserving).
--    'INBOUND' (the legacy default, i.e. a receiving dock) maps to RECEIVING.
--    Anything else must already be one of the enum labels (case/whitespace
--    tolerant); an unknown value raises instead of guessing.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stations'
      AND column_name = 'department' AND data_type <> 'USER-DEFINED'
  ) THEN
    ALTER TABLE stations ALTER COLUMN department DROP DEFAULT;
    ALTER TABLE stations ALTER COLUMN department TYPE "StationDepartment"
      USING (
        CASE upper(btrim(department::text))
          WHEN 'INBOUND'   THEN 'RECEIVING'::"StationDepartment"
          WHEN 'RECEIVING' THEN 'RECEIVING'::"StationDepartment"
          WHEN 'SORTING'   THEN 'SORTING'::"StationDepartment"
          WHEN 'PUTAWAY'   THEN 'PUTAWAY'::"StationDepartment"
          WHEN 'PACKING'   THEN 'PACKING'::"StationDepartment"
          WHEN 'INVENTORY' THEN 'INVENTORY'::"StationDepartment"
          WHEN 'DISPATCH'  THEN 'DISPATCH'::"StationDepartment"
          ELSE department::text::"StationDepartment"
        END
      );
    ALTER TABLE stations ALTER COLUMN department SET NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. stations.capabilities: TEXT[]  →  StationCapability[] (data-preserving).
--    Each element is matched case-insensitively to an enum label; unknown
--    values raise instead of being silently dropped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  needs BOOLEAN;
BEGIN
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = 'stations'::regclass AND a.attname = 'capabilities'
        AND NOT a.attisdropped AND t.typtype = 'e' AND t.typname = 'StationCapability'
    )
  INTO needs
  WHERE EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = 'stations'::regclass AND a.attname = 'capabilities'
      AND NOT a.attisdropped
  );

  IF needs THEN
    ALTER TABLE stations ADD COLUMN capabilities_new "StationCapability"[];
    UPDATE stations SET capabilities_new =
      CASE WHEN capabilities IS NULL THEN NULL
           ELSE ARRAY(
             SELECT (CASE upper(btrim(e))
               WHEN 'CAMERA'         THEN 'CAMERA'::"StationCapability"
               WHEN 'BARCODE_SCANNER' THEN 'BARCODE_SCANNER'::"StationCapability"
               WHEN 'QR_SCANNER'     THEN 'QR_SCANNER'::"StationCapability"
               WHEN 'OCR'            THEN 'OCR'::"StationCapability"
               WHEN 'PRINTER'        THEN 'PRINTER'::"StationCapability"
               WHEN 'SCALE'          THEN 'SCALE'::"StationCapability"
               ELSE e::text::"StationCapability"
             END)
             FROM unnest(capabilities::text[]) AS e
           )
      END;
    ALTER TABLE stations DROP COLUMN capabilities;
    ALTER TABLE stations RENAME COLUMN capabilities_new TO capabilities;
    ALTER TABLE stations ALTER COLUMN capabilities SET DEFAULT ARRAY[]::"StationCapability"[];
  END IF;
END $$;

-- Recreate the index that was dropped together with the old column.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'stations'
      AND indexname = 'stations_department_idx'
  ) THEN
    CREATE INDEX stations_department_idx ON stations (department);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. ScanType enum: drop the obsolete OCR variant by rewriting the type.
--    Every column typed with public."ScanType" (across all schemas, incl. the
--    freshly archived legacy table) is remapped 'OCR' → 'MANUAL' and recast.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _scan_type_columns ON COMMIT PRESERVE ROWS AS
SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
FROM pg_type t
JOIN pg_namespace tn ON tn.oid = t.typnamespace
JOIN pg_attribute a ON a.atttypid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE t.typname = 'ScanType' AND tn.nspname = 'public'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');

DO $$
DECLARE
  r RECORD;
  has_ocr BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM unnest(enum_range(NULL::"ScanType")) v WHERE v::text = 'OCR'
  ) INTO has_ocr;

  IF NOT has_ocr THEN
    RAISE NOTICE 'ScanType already reconciled (no OCR variant) — skipping.';
    RETURN;
  END IF;

  -- Remap rows + drop column defaults that reference the old enum type.
  FOR r IN SELECT * FROM _scan_type_columns LOOP
    EXECUTE format(
      'UPDATE %I.%I SET %I = %L WHERE %I = %L',
      r.schema_name, r.table_name, r.column_name, 'MANUAL', r.column_name, 'OCR'
    );
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I DROP DEFAULT',
      r.schema_name, r.table_name, r.column_name
    );
  END LOOP;

  -- Rebuild the enum without OCR and recast every column onto it.
  EXECUTE 'CREATE TYPE "ScanType_reconciled" AS ENUM (''QR'', ''BARCODE'', ''MANUAL'')';
  FOR r IN SELECT * FROM _scan_type_columns LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE "ScanType_reconciled" USING (%I::text::"ScanType_reconciled")',
      r.schema_name, r.table_name, r.column_name, r.column_name
    );
  END LOOP;
  EXECUTE 'DROP TYPE "ScanType"';
  EXECUTE 'ALTER TYPE "ScanType_reconciled" RENAME TO "ScanType"';
END $$;

-- Restore the schema-declared default on the live cartons column.
ALTER TABLE receiving_cartons ALTER COLUMN "scanType" SET DEFAULT 'MANUAL'::"ScanType";

DROP TABLE _scan_type_columns;
