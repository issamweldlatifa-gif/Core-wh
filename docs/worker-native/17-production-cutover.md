# 17 · Production cutover / controlled pilot runbook

## Decision: NO-GO — CUTOVER NOT AUTHORIZED

No production deployment, release, fleet update or stock operation was performed. This repository change is a Receiving-first migration pilot. Full Picking, strict Putaway, Inventory, Returns, formal receiving condition/disposition and physical acceptance remain incomplete. A compiled APK alone cannot satisfy the user's completion criteria.

## Gate ledger

| Gate | Current decision |
|---|---|
| Source audit, endpoint contracts, extraction boundaries | Documented; source authority preserved. |
| Native CI/test/lint | PASS: 91 JVM tests, APK build/lint/test APK compile at `b0771e8`; report15. |
| Instrumentation / secure-storage and device upgrade | Eight cases compile but execution and physical upgrade remain pending. |
| Backend BC-01…06 and source-matching schema deployment | BLOCKED / owner decisions and implementation required. |
| Complete Receiving real API/DB/device validation | NOT RUN. |
| Complete other critical workflows and role matrix | NOT IMPLEMENTED/VALIDATED. |
| Authorized offline/sync protocol or approved online-only operating scope | No offline stock authority. Online-only pilot is not full offline acceptance. |
| Physical scanner/ergonomics/interruption tests | NOT RUN (report16). |
| Legacy/Admin/backend regression, including W-10 | Partial unit evidence; frontend baseline typecheck failure remains. |
| Signed artifact/update identity/rollback drill | NOT PREPARED or tested. |
| Warehouse/security/backend/release owner sign-off | NOT GIVEN. |

## Preparation before any approved pilot

1. Name warehouse operations, backend, Android/MDM, security, QA and release owners. Approve explicit scope/cohort/station/test inventory and stop criteria.
2. Match staging API commit/schema/permissions to report03; implement/validate missing contracts separately. Never use a convenient production URL as proof of compatibility.
3. Build reproducibly from reviewed branch/commit with JDK17/SDK35 and an approved HTTPS API root. Record APK hash, versionCode, signing certificate, dependency and scanner profile revisions. There is one package: `com.ayrovi.worker`.
4. Debug APKs are QA only (latest artifact linked in report15). Release is intentionally unsigned until the organization's secure signing process supplies the existing trusted identity. Do not change package ID or uninstall/clear app data to evade signature conflicts.
5. Validate encrypted-store upgrade, retained device registration and unresolved-operation preservation. Provision operational accounts and device/station mappings through existing Admin tools; no credentials in chat/Git.
6. Keep a tested, signed previous artifact outside Git plus the frozen web reference. Same-package downgrade/update/MDM procedure must be tested. Source code is not an installable rollback.
7. Execute reports15–16 and real stock/audit checks. No production pilot approval inferred from unit passes.

## Controlled execution once approved

Start with a specifically authorized Receiving cohort and staffed supervision. Do not expose incomplete workflows or count them as accepted. Compare physical units/cartons/totes with authoritative ArticleUnit, reconciliation and audit records. Record observed scan success/failure, duplicate dispatch, server-confirmation latency, unresolved writes, auth/permission failures, operator usability and task completion outcomes. Agree metric thresholds before the run; none are fabricated here.

Do not run native and legacy receipt entry concurrently for the same task. An uncertain write locks further dispatch; investigate it before changing clients. No automated rollback replay, background outbox or N-request receipt batch.

## Immediate stop criteria

Unauthorized effect, duplicate/missing stock, unprovable mutation outcome without safe reconciliation, false success, unstable device identity, plaintext token exposure, scanner lifecycle/repeat failure, unsafe location handling, unavailable recovery, or critical Admin/backend regression. Stop impacted work, isolate device/task, retain evidence and reconcile physically/server-side before any resumption.

## Rollback/recovery procedure

- Stop new work; record worker/device/session/last confirmed article and unresolved marker. Do not clear app data or reuse the label.
- Supervisor checks authoritative server/audit/physical stock. Article ambiguity cannot be resolved from tally alone; close/reconcile through approved tools. If the old worker can no longer authenticate, escalate to backend/security owners—no local “ignore hold” button.
- The new frozen-build entry is blocked when a native recovery marker exists. Only after reconciliation and explicit clearance may the tested same-package rollback or approved web terminal be used.
- A controlled device reset is a last-resort admin procedure **after documented reconciliation**, with re-registration and signing/update plan. It is not an operational retry mechanism.
- Server-revocation failures on logout require administrator revocation; do not assume local sign-out revoked all remote sessions.

## Full cutover

Only after every critical workflow, backend enforcement, error/connection/offline policy, hardware and pilot gate passes: approve cohort expansion, monitor agreed stabilization window, retain rollback until exit criteria, then authorize retirement in report18. This runbook is a plan, not an executed cutover record.
