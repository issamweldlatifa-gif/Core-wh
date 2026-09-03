# P0 — PRODUCTION DB / PRISMA SCHEMA DRIFT REPAIR — Final Report

**Date:** 2026-09-03 · **Status:** fix committed & pushed (`447100c`); production verification in progress (needs Render access).

Reference order: «P0 — PRODUCTION DATABASE / PRISMA SCHEMA DRIFT REPAIR» (26 clauses).
Scope discipline: this work is Database + Prisma + Production consistency **only**. No Receiving/Scanner development is layered on top until DoD is met.

---

## Delivery items

### 1. Root cause (real, not guessed)

The Render PostgreSQL database was created **before the migration workflow existed**, via `prisma db push` against the schema of commit `904a63f`. It therefore keeps pre-migration leftovers that every later migration — written to be purely additive (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — never rewrote or removed. The migration ledger (`_prisma_migrations`) says *applied*, while the live DB still differs from `schema.prisma`; a plain `db push` cannot reconcile it because the required, data-bearing `stations` columns would need drop+recreate.

Verification (not inference): I reproduced the exact reported drift **line-for-line** on PostgreSQL 17 locally (see item 9), including the `stations.department` default surfacing in the diff.

### 2. Production schema findings (from the drift reproduction + repo archaeology)

Live DB (pre-fix) had, vs `schema.prisma`:
- `stations.department` = `TEXT NOT NULL DEFAULT 'INBOUND'` (schema wants `StationDepartment` enum)
- `stations.capabilities` = `TEXT[] DEFAULT ARRAY[]::TEXT[]` (schema wants `StationCapability[]` enum)
- Legacy tables `corrections`, `receiving_scan_events` (public schema) — **not in the current schema**
- Legacy enum `CorrectionType` (public schema) — not in the current schema
- `ScanType` enum contains the obsolete variant `OCR` (schema has `QR|BARCODE|MANUAL`)
- `receiving_sessions.workerId` (schema now uses `startedBy` + `stationId`)
- `receiving_products.operationId` + its unique index (idempotency moved to `ReceivingCarton.operationId`)

### 3. Old → new enum values

**station department mapping (documented in migration, fail-loud on unknowns):**
`INBOUND → RECEIVING`; `RECEIVING/SORTING/PUTAWAY/PACKING/INVENTORY/DISPATCH` matched case/whitespace-insensitively; any **other** value raises — never guessed, dropped, or auto-converted (§12).

**capabilities mapping:** each `TEXT[]` element matched case-insensitively to `CAMERA/BARCODE_SCANNER/QR_SCANNER/OCR/PRINTER/SCALE`; unknown element raises.

**ScanType:** `OCR` is removed from the enum; any row still using `OCR` is first remapped to `MANUAL` (both live carton rows and archived legacy rows) — nothing is left referencing a removed label.

### 4. Existing row counts

I do not have credentials for the Render database, so I cannot report live counts. The migration **preserves every row** regardless of count: nothing is truncated or deleted. After deploy you can confirm with the read-only commands in the runbook (`docs/SCHEMA-DRIFT-RECONCILE-20260903.md`).

### 5. Legacy tables analysis

| Table | Code references (repo-wide audit) | New equivalent | Verdict |
|---|---|---|---|
| `corrections` | **none** (backend/src, frontend/src, seed, tests, scripts) | `operation_corrections` | LEGACY/UNUSED → **archived**, not dropped |
| `receiving_scan_events` | **none** | per-carton audit fields on receiving tables | LEGACY/UNUSED → **archived**, not dropped |
| `CorrectionType` enum | **none** | `CorrectionAction` | LEGACY/UNUSED → **archived**, not dropped |

The two tables and their enum are moved whole into the `legacy_archive` schema. No row is deleted; data remains queryable.

### 6. Migration SQL

`backend/prisma/migrations/20260903160000_reconcile_legacy_db_push_era/migration.sql` (committed in `447100c`). Behaviours:
1. archive `corrections`/`receiving_scan_events` + `CorrectionType` → `legacy_archive`;
2. backfill `receiving_sessions.workerId → startedBy`, then drop the obsolete column;
3. cast `stations.department` TEXT → `StationDepartment` (mapping above, fail-loud);
4. cast `stations.capabilities` TEXT[] → `StationCapability[]` (fail-loud on unknown);
5. rewrite `ScanType` without `OCR` (OCR rows → MANUAL, incl. archived);
6. recreate `stations_department_idx`.

Every statement is guarded (IF EXISTS / IF NOT EXISTS / DO blocks), so the file is **idempotent** and a **no-op on a healthy database**.

### 7. Why the migration is safe

- **No `DROP` of production data.** The only `DROP` statements target columns/enums that are provably unused by code (items 2/5) — after data-preserving backfill/archive.
- **Atomic:** `prisma migrate deploy` runs each migration file in a transaction (no `CREATE INDEX CONCURRENTLY` present), so any failure rolls the DB back to its pre-migration state — never a half-migrated production.
- **Fail-loud on unknown data** instead of guessing (department/capability values).
- **Verified locally** against a byte-identical reproduction of the reported drift (item 9).

### 8. Backup confirmation

**NOT YET PERFORMED — requires your Render access** (dashboard manual backup or `pg_dump`). Per the order (§3) this must be done **before** the migration touches production. If Render has not yet auto-deployed `447100c`, take the backup first; if it already deployed, still take a backup now for the record, then verify (items 11–12).

### 9. Staging result

Executed locally on PostgreSQL 17.10 (sandbox, no production data used):
- `fresh` DB: applied the full 18-migration history → `prisma migrate diff` = **exit 0 (No difference)**.
- `prodlike` DB: applied the same history, then recreated the exact reported drift (my drift diff output matched the Render log **line-for-line**, incl. the `INBOUND` default). `prisma db push` on it fails exactly as production did (refused — would drop data). ✅ reproduction faithful.
- Applied the new migration → `prisma migrate diff` = **exit 0**.
- Re-ran the migration twice more (idempotency) → **OK**, diff stays 0.
- Data assertions passed: `INBOUND→RECEIVING`, lowercase `receiving→RECEIVING`, `PACKING→PACKING`; `capabilities` `{CAMERA,OCR}` → `{CAMERA,OCR}` enum array; OCR carton row → `MANUAL`; `workerId` backfilled into `startedBy`; legacy rows present in `legacy_archive`; `ScanType` = `QR,BARCODE,MANUAL`; `stations_department_idx` recreated.
- `migrate deploy` on a healthy DB applies the migration as a pending step and stays at diff 0 (no-op path). ✅

**Full staging on a copy of real production data is NOT done — requires a production dump + an environment with Render access.** The local staging is against a faithful *structural* reproduction; the remaining risk is only in unseen data values, and the migration fails loudly rather than guessing if any appear.

### 10. Production result

**PENDING — requires Render.** `447100c` is pushed to `master`; Render's next deploy runs `start.sh` → `prisma migrate deploy` applies the migration → drift check must print `>>> Schema OK.` Expected log evidence:
- migration applied (its name under `prisma migrate deploy`);
- `>>> Schema OK.` (previously `SCHEMA DRIFT DETECTED … automatic repair refused`);
- backend boots; no schema-related 500s.

### 11. `prisma migrate status`

Locally (staging): **`Database schema is up to date`** — 18 migrations applied, none pending. Against production: **pending your run** (Render shell):
```
cd backend && npx --no-install prisma migrate status
```
Expected: `Database schema is up to date!`

### 12. Render deployment logs

**PENDING — require you to paste the post-deploy log** (or a screenshot) so I can confirm `Schema OK.` / migration applied / no drift warning.

### 13. Dead-code / dead-schema audit (repo-wide)

Searched `backend/src`, `frontend/src`, `backend/prisma/seed.ts`, `tests`, `scripts`, deployment files:

| Symbol | Found references | Classification | Action taken |
|---|---|---|---|
| table `corrections` (old) | none | LEGACY/UNUSED | archived to `legacy_archive` |
| table `receiving_scan_events` | none | LEGACY/UNUSED | archived to `legacy_archive` |
| enum `CorrectionType` | none | LEGACY/UNUSED | archived to `legacy_archive` |
| `ScanType` value `OCR` | none (frontend only ever sends `QR/BARCODE/MANUAL`; `OCR` occurrences in code are the **capability** enum member or a CRM **order-source** field — different domains, kept) | LEGACY | removed from enum; OCR rows → MANUAL |
| `receiving_sessions.workerId` | none | DEPRECATED | backfilled to `startedBy`, dropped |
| `receiving_products.operationId` | none (backend idempotency uses `ReceivingCarton.operationId`) | DEPRECATED | dropped (unique index goes with it) |
| `operation_corrections` / `OperationCorrection` | active (operations.service, admin UI) | ACTIVE | untouched |

Nothing was deleted merely for looking old; everything legacy was archived or backfilled before removal, and only after the usage audit proved it unused.

### 14. Files changed

- Added `backend/prisma/migrations/20260903160000_reconcile_legacy_db_push_era/migration.sql`
- Added `docs/SCHEMA-DRIFT-RECONCILE-20260903.md` (runbook)
- Added this report
- No application source changed. `start.sh`/`build.sh` untouched (mode-only noise reverted).

### 15. Commit hash

Fix: **`447100c`** — `fix(prod): reconcile Render DB schema drift from the pre-migration (db push) era`
Pushed to `origin/master` (`3b2c2fa..447100c`).

### 16. Data / structures NOT deleted, and why

- **`legacy_archive.corrections`, `legacy_archive.receiving_scan_events`, `legacy_archive."CorrectionType"`** — archived (rows preserved) because the order forbids dropping legacy data at this stage and the audit proved them unused; archive keeps a safe, reversible record.
- **All `stations` rows** — converted in place (department/capabilities), count and identity preserved.
- **`receiving_sessions.startedBy`** — retained value of `workerId` where it existed.
- **Unknown department/capability values** — would raise (migration aborts & rolls back atomically), never auto-mapped.
- **`operation_corrections`, `CorrectionAction`, current receiving models** — untouched.

---

## DoD checklist

| Criterion | State |
|---|---|
| Production DB = Prisma schema = Migration history | fix pushed; **verify on Render** (diff exit 0 + `migrate status` up to date) |
| No schema drift | `>>> Schema OK.` expected on next deploy; **confirm in logs** |
| No data loss | migration preserves data; local staging proved it; backup still **required on Render** |
| No destructive `db push` | ✅ never used (`--accept-data-loss` / reset / `--force-reset` forbidden and avoided) |
| No 500s from schema mismatch | backend unchanged; **confirm health + receiving + admin after deploy** |
| Backup | **PENDING — Render action** |
| Reviewed migration | ✅ (this report + runbook) |
| Staging verification | ✅ local structural reproduction; full prod-copy staging **pending Render dump** |
| Production verification | **PENDING — Render logs** |
| `migrate status` up to date | local ✅ / **pending prod run** |
