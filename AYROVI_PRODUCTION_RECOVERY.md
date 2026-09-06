# AYROVI production recovery procedure

**Status: documented procedure, restore/rollback NOT EXECUTED or certified in this session.**

## Ownership and prerequisites

Backend/database, warehouse operations, security/MDM and release owners must approve a maintenance window. Record actual Render service/database IDs, deployed commit, schema/migration state, signing certificate, device profiles and operational task/receipt holds. Keep credentials in the approved secret store, not commands/logs/chat/Git.

## Database backup / restore

1. Stop new warehouse mutations through an approved maintenance procedure; do not erase pending device journals.
2. Take a consistent PostgreSQL custom-format backup using managed connection environment/PGPASSFILE. Encrypt and store it externally with timestamp, source database/version, checksum, retention and access controls.
3. Restore to an isolated database using the same PostgreSQL version. Verify FK/unique constraints, migration history, worker assignments, ArticleUnits/container/order/shipping totals and audit records.
4. Run the non-production validation suite against that restore. Production restore approval requires an observed successful drill, not merely a backup file.
5. Only after approval switch application configuration to the recovered database or perform the controlled restore. Reconcile any operation that may have been committed during interruption.

## Migration failure / drift

Startup now runs reviewed `prisma migrate deploy` and schema comparison, and stops on failure. It does **not** automatically mark failed migrations rolled back, run `db push`, accept data loss or print generated credentials. Runtime production bootstrap does not silently run schema repair.

If a migration fails: preserve logs and migration rows; identify exactly which DDL/data changes committed; compare with the tested migration; restore the verified backup or apply an owner-reviewed forward repair. Never mark a migration applied/rolled-back simply to get a green health check. The imported worker operational migration changes assignment enum values and station/device references; existing data mapping must be reviewed before Production.

## Application / Android rollback

Retain immutable approved backend artifacts and signed Worker APKs with hashes/certificates. Roll back application code only when compatible with the actual schema; code rollback does not reverse a data migration. Preserve package ID/signing identity. Do not uninstall or clear Worker app data to bypass signing conflicts while a receipt is unresolved.

For ambiguous receipts: isolate the device/task, compare physical stock with ArticleUnit/container/audit state, and reconcile through authorized operations. Do not replay a label or discard the encrypted marker. Supervisor approval is required for reassignment/reopen/correction.

## Configuration and auth recovery

Back up real routing/station/device/role configuration externally. Revoke compromised/unknown sessions through Admin. Rotate credentials in the secret manager and re-register/rebind devices only after verifying real identity. Bootstrap does not overwrite an existing admin password or create demo warehouse data; production demo seed is explicitly forbidden.

## Post-recovery verification

Require exact deployed commit, DB/schema readiness, authenticated role/assignment checks, a controlled complete-chain test, actual CT40/Phone scanning, monitored errors/latency and warehouse sign-off. `HTTP200` or a stale healthy service is not proof of successful recovery. Record results in the Go-Live report.
