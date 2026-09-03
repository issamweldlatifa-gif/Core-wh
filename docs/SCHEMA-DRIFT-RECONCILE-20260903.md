# Production schema drift — reconciliation (2026-09-03)

**Status:** fixed by migration `20260903160000_reconcile_legacy_db_push_era` (this doc is the runbook).

## Symptom (Render backend deploy log)

`start.sh` printed:

```
>>> !!! SCHEMA DRIFT DETECTED: live DB does not match schema.prisma.
>>> Repairing with 'prisma db push' (creates missing tables/columns)...
Error: We found changes that cannot be executed:
  Changed the type of 'department' on the 'stations' table. No cast exists,
  the column would be recreated, which cannot be done since the column is
  required and there is data in the table.
>>> WARNING: automatic repair refused (would lose data).
>>> Manual action required: npx prisma db push --accept-data-loss
```

## Root cause

The Render PostgreSQL database was created in the **pre-migration era with
`prisma db push`** against a schema (commit `904a63f`) in which:

- `stations.department` was `TEXT NOT NULL DEFAULT 'INBOUND'`
- `stations.capabilities` was `TEXT[] DEFAULT ARRAY[]::TEXT[]`
- legacy tables `corrections` and `receiving_scan_events`, enum
  `CorrectionType`, and an `OCR` variant inside the `ScanType` enum existed
- `receiving_sessions.workerId` and `receiving_products.operationId` existed

Later migrations were written to be **purely additive** (`CREATE ... IF NOT
EXISTS`, `ADD COLUMN IF NOT EXISTS`), so they never rewrote the pre-existing
`stations` columns and never removed the legacy objects. The migration ledger
says "applied" while the live DB still differs from `schema.prisma` — and a
plain `db push` cannot reconcile it without dropping data.

## The fix

`backend/prisma/migrations/20260903160000_reconcile_legacy_db_push_era/migration.sql`
is **data-preserving and idempotent**:

1. Moves the legacy tables `corrections` / `receiving_scan_events` and the
   `CorrectionType` enum into a `legacy_archive` schema (nothing deleted —
   rows stay queryable at `legacy_archive.corrections`, etc.).
2. Backfills `receiving_sessions.workerId → startedBy` before dropping the
   obsolete column.
3. Casts `stations.department` text values onto the `StationDepartment` enum:
   `'INBOUND' → 'RECEIVING'`, others matched case-insensitively; an unknown
   value **fails loudly** (never silently mis-assigns).
4. Casts `stations.capabilities` `TEXT[]` values onto `StationCapability[]`.
5. Rewrites `ScanType` without the `OCR` variant (archived rows using `OCR`
   are remapped to `MANUAL` first).
6. Recreates `stations_department_idx`.

Verified locally on PostgreSQL 17 against a byte-identical reproduction of the
reported drift (`prisma migrate diff` output matched line-for-line before the
fix; `No difference detected` / exit 0 after). Idempotent re-runs pass, and it
is a no-op on a healthy database.

## Runbook

1. **Back up the production database first** (Render → database → Manual
   backup / `pg_dump`). This migration is data-preserving but touches live DDL
   on `stations`, `receiving_sessions`, `receiving_products` and the `ScanType`
   enum.
2. Optional pre-flight (read-only) inspection — values to know before deploy:
   ```sql
   SELECT department, capabilities, count(*) FROM stations GROUP BY 1, 2;
   SELECT count(*) FROM corrections;             -- legacy tables (if they exist)
   SELECT count(*) FROM receiving_scan_events;
   ```
   Nothing in these tables is deleted by the migration: the legacy tables are
   moved whole to the `legacy_archive` schema (verify afterwards):
   ```sql
   SELECT count(*) FROM legacy_archive.corrections;
   SELECT count(*) FROM legacy_archive.receiving_scan_events;
   ```
3. Push the change to `master`. Render's release step runs `start.sh`, which
   runs `prisma migrate deploy` → applies the new migration → the drift check
   prints `>>> Schema OK.` instead of the SCHEMA DRIFT warning.
4. Verify: boot log contains `Schema OK.` and no `SCHEMA DRIFT DETECTED`;
   optionally re-run the diff manually from the Render shell:
   ```
   npx --no-install prisma migrate diff --from-url "$DATABASE_URL" \
     --to-schema-datamodel prisma/schema.prisma --exit-code   # exit 0
   ```

## What NOT to do

- Do **not** run `prisma db push --accept-data-loss` or `--force-reset` — they
  drop/recreate the live `stations` columns and delete rows.
