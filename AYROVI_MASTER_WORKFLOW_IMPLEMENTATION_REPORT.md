# AYROVI — MASTER WORKFLOW: Implementation Report

**Branch:** `arena/01a077eb-core-wh` (branched from `master` @ `f1434fd`)
**Date:** 2026-09-06
**Status:** Backend + Admin frontend implemented and verified end-to-end. Production deploy and Android release are **BLOCKED** (see §9) — nothing is reported as deployed or released without proof.

---

## 1. What the Master Order required

One coherent, end-to-end system: **EXTERNAL CRM → Backend integration (idempotent) → Admin auto-processing/monitoring → auto task generation/dispatch → ONE Worker domain (CT40 + Phone) → Backend validation → automatic next task.**

Chain: CRM arrival → **Receiving** (carton & product scan tasks, clear operational errors, REPORT PROBLEM) → completion → **auto next task** → **Container fill** (capacity 50, manual close) → **temp storage station/zone** → **Sorting** (customer cards, auto product→customer-container matching) → customer container complete → **QR generated + card locked** → **Packing** → **Shipping Ready** (scan QR, verify customer/container/status, click SHIPPING) → **Bordereau printable/searchable in Admin**.

Governing rules (all satisfied): ONE task system, ONE backend authority, ONE scanner core with a single normalization boundary, no raw technical errors to workers, full audit trail, Admin Control Center upgrade.

---

## 2. What was implemented

### 2.1 Automatic task dispatch engine (the core of "auto next task")
`backend/src/modules/assignments/dispatch.service.ts` (NEW) — `TaskDispatchService`.
When a workflow event happens, the backend auto-creates the **next** `WorkerTaskAssignment` for an **eligible** worker, **atomically** with the state transition (single `$transaction`).

- **Eligibility:** ACTIVE user · permission granted by an **OPERATIONAL-class** role (admins are *never* floor workers) · no conflicting station/department binding.
- **Ordering:** station-matched (configured routing) first · then fewest open assignments (operational availability).
- **Idempotent** per `(taskKey + entity)`; a `BLOCKED` task still counts as open.
- Every dispatch is audited (`TASK_AUTO_DISPATCHED`).
- Hand-offs wired into the chain: `onArrival` → Receiving · `onContainerClosed` → Receiving-Container · `onContainerStaged` → (complete container task +) Sorting · `onOrderGoodsAvailable` → Order-Sorting · `onCustomerBinLocked` → Packing · `onPacked` → Shipping.

This is the single mechanism that turns each backend validation into the automatic next worker task.

### 2.2 End-to-end chain services
- **expected-arrivals:** CRM arrival card → `ExpectedArrival` (idempotent replay, `customerArrivalCardId` anchor) + customer name persisted + auto Receiving task.
- **orders:** CRM order card idempotency (`externalOrderReference`), customer projection (name/surname) kept for cards, container labels and bordereau search (no local customer master — invariant preserved).
- **receiving:** session + scan tasks (carton & article), **single scan normalization** (`common/scan-normalizer.ts`, NEW) with mixed-case handling, discrepancy flagging, completion gates, supervisor gate on a discrepant close.
- **fulfillment:** container fill/close (capacity 50, manual close) · **stage to STAGING station/zone** (temporary storage) · sorting (customer cards + product→customer-container auto matching) · **customer bin completion → server-generated QR `AYROVI:BIN-…:ORDER:CUSTOMER` + card LOCK** · packing (scan, `complete=true`) · **shipping with pre-dispatch verification** (customer/container/status + content hash, single-use, 10-min expiry; `ship` re-checks the hash so contents can't change between verify and dispatch) · **bordereau search/fetch** · worker **exceptions (any stage)** + admin resolve · **article traceability**.
- **operations:** station `PATCH` gains `department` + `zoneId` (validated, audited; zone visible in list/findOne) — station/zone is **admin configuration, not code**.

### 2.3 Admin corrections
`reopenCustomerBin` — the **ONLY** authorized path back from a locked customer bin (`READY_FOR_PACKING → ACTIVE`, customer QR cleared). A worker can never do this. It records an `OperationCorrection` with **before/after snapshots**, the author, IP and a mandatory reason, plus an audit entry. Guards: only customer containers, not already open, not PACKED/CLOSED, reason length enforced.

### 2.4 Admin Control Center (frontend)
- **Stations page:** `STAGING` department added; zone selector on create + inline department/zone editing on every row (the S11 configuration surface).
- **Customer Bins page:** locked bins get a **reopen** action (gated on `operations.correct`) through the standard correction dialog (mandatory reason, original state shown, history preserved).

### 2.5 NOT_IMPLEMENTED (per Master Order §36 — no fake worker tasks)
**Picking · Inventory / Cycle Count · Returns · Replenishment.** These are flagged, not stubbed, in the task registry and documented here.

---

## 3. Hard rules preserved (invariants — MUST NOT CHANGE)
- Idempotency contracts: `customerArrivalCardId`, `externalShipmentId`, `externalCartonId`, `operationId`.
- Append-only ledgers: `CartonPlacement`, `OperationCorrection`, `ReceivingScanEvent`.
- Restrict/SetNull deletion policy; expected data immutable during receiving.
- Supervisor gate on closing a discrepant receiving.
- Worker never sees Admin; worker never writes workflow state directly.
- `bootstrap-schema-repair.ts` in-process self-repair (the only mechanism proven to run in production regardless of Render Start Command).
- **One task system** (`WorkerTaskAssignment`), **one scanner core**, **one permissions authority** (RBAC re-read per request). No second task table, state machine, API, scan engine or permission system was introduced.

---

## 4. Test evidence (real, reproducible)

### 4.1 Unit tests
| Suite | Result |
|---|---|
| Backend (`npx jest`, 14 suites) | **111 passed / 0 failed** |
| Frontend (`npx vitest run`, 13 files) | **118 passed / 0 failed** |
| Backend `tsc --noEmit` | clean |
| Frontend `tsc --noEmit` + `vite build` | clean + production build OK |

The dispatch rules are pinned by `dispatch.service.spec.ts`: eligibility, admin-class exclusion, station/department conflict, station-match preference, availability tie-break, idempotency, BLOCKED-as-open, and the staging hand-off.

### 4.2 Live-HTTP end-to-end (real server on an embedded Postgres, `:3100`)
| Chain script | Coverage | Result |
|---|---|---|
| `aitest/e2e-master-chain.sh` (A→K) | arrival → auto Receiving → carton+article scans → auto Receiving-Container → close+stage → auto Sorting → order goods → auto Order-Sorting → store/assign → **bin READY_FOR_PACKING + QR + lock** → auto Packing → pack → `OUT-000001` → auto Shipping → **verify-gated dispatch** (re-ship 409) → **SHIPPED** → bordereau search (customer + code) → report problem → admin resolve → article trace | **60 PASS / 0 FAIL** |
| `aitest/e2e-admin-corrections.sh` (L) | station create/zone, PATCH department+zone, invalid zone 404, invalid department 400, **REOPEN_CUSTOMER_BIN** (reopen, ACTIVE + QR cleared, reopen-open 400, trivial reason 400, non-customer 400, listed on corrections board) | **23 PASS / 0 FAIL** |

A product bug found and fixed by these tests: the floor-dispatch `eligibleWorkers` filter matched any `isSystem` role, so SUPER_ADMIN was receiving `sorting`/`packing`. Fixed by filtering on `applicationClass === 'OPERATIONAL'`.

---

## 5. Deliverable artefacts (paths)
- Dispatch engine: `backend/src/modules/assignments/dispatch.service.ts` (+ `dispatch.service.spec.ts`)
- Scan normalization: `backend/src/common/scan-normalizer.ts`
- Station/zone config: `backend/src/modules/operations/stations.service.ts`, `operations.controller.ts`
- Reopen correction: `backend/src/modules/operations/corrections.service.ts`, `operations.controller.ts`
- Admin UI: `frontend/src/admin/pages/Stations.tsx`, `CustomerBins.tsx`, `frontend/src/admin/api.ts`
- Schema + migration: `backend/prisma/schema.prisma`, `backend/prisma/migrations/20260906180000_master_workflow_chain/`
- E2E: `aitest/e2e-master-chain.sh`, `aitest/e2e-admin-corrections.sh`, `aitest/bootstrap-stations.js`
- Plan: `AYROVI_MASTER_WORKFLOW_IMPLEMENTATION_PLAN.md`

---

## 6. Git
Branch `arena/01a077eb-core-wh`, **pushed to GitHub**, 4 commits on top of `master` (`f1434fd`):

| SHA | Subject |
|---|---|
| `5bc0e5f` | Master Workflow: data model (staging, customer QR/lock, shipping verification, stage exceptions, station zone, customer projection) |
| `67b9d77` | Master Workflow: end-to-end chain + automatic task dispatch engine |
| `83ffd82` | Master Workflow: implementation plan + decisions (AYROVI master order) |
| `42814f1` | Master Workflow: admin station/zone config UI + reopen-customer-bin action |

Diff vs `master`: **25 files changed, 2160 insertions(+), 96 deletions(-).**
Migration `20260906180000_master_workflow_chain` is **additive only** (alter/add columns, new tables, new enum values) — no destructive changes.

---

## 7. Versioning (Android)
- `versionCode` = **45**
- `versionName` = **1.5.1-rc1**
- Source: `mobile/app/build.gradle.kts`

---

## 8. Production data-cleanup / migration plan
- Migration is additive; run `prisma migrate deploy` (or the in-process `bootstrap-schema-repair.ts`, which is what actually runs in production).
- **No destructive operation** was performed against production data. All testing ran against a disposable embedded Postgres (`ayrovi_test`), truncated between runs.
- Rollback: the migration only adds columns/tables/enum values, so the prior deploy remains compatible (new fields are nullable / default-set).

---

## 9. BLOCKED items (reported per §40 — no invented workarounds, no false "deployed"/"released")

| Item | Status | Blocker | REQUIRED DECISION |
|---|---|---|---|
| **Render production deployment** | **BLOCKED** | No Render credentials and no network egress to Render in this sandbox. | Provide Render API token / dashboard access, or confirm the production branch and deploy manually. |
| **Live URL** | **N/A** | Depends on the Render deployment above. | Provide the deployed URL once the deploy lands. |
| **Android release APK** | **BLOCKED** | No JVM / Android SDK (egress restricted; GitHub release-asset host blocked) → cannot build a signed release APK. | Provide a JVM+SDK build environment or prebuilt signing; then build `release` and publish. |
| **APK path** | **N/A** | No APK was built (only `versionCode`/`versionName` are set). | See above. |
| **GitHub Release (with permanent APK link)** | **BLOCKED** | Requires the release APK, which is blocked. | See above. |

**Explicit:** the production app was **not** deployed and **no** APK/release was created or linked. `versionName`/`versionCode` above reflect the repo source only.

---

## 10. Known limitations / open (non-blocking)
1. **Staging station codes/zones for production** are configuration, not code — Admin must set the STAGING station(s) + zone(s) in production (§11).
2. **Bordereau print layout** fields beyond customer/order/QR/contents are TBD (business confirmation).
3. **Sorting path** is currently optional: an article may go tote → customer bin directly, or tote → storage → bin. Confirm whether category-storage sorting is mandatory.
4. **Missing workflows** (Picking, Inventory/Cycle Count, Returns, Replenishment) are intentionally **NOT_IMPLEMENTED** — no worker tasks exist for them.
5. **Honeywell CT40 hardware trigger** is a hardware/device-pairing concern (device registry + strict device binding); the workflow itself is identical across CT40 and Phone and is covered by the e2e chain, but physical CT40 trigger testing still requires the device.
6. The two integration e2e scripts assume the seeded `admin` / `WORKER001` / `WORKER-ALL` accounts and the `e2e-integration-key`; production uses real credentials.

---

## 11. How to reproduce the verification locally
```bash
# Backend unit tests
cd backend && npx jest            # 111 passed
npx tsc --noEmit                  # clean

# Frontend unit tests + build
cd frontend && npx vitest run     # 118 passed
npx tsc --noEmit && npx vite build

# Live-HTTP e2e (needs the backend running against a seeded test DB on :3100)
bash aitest/e2e-master-chain.sh        # 60/60
bash aitest/e2e-admin-corrections.sh   # 23/23
```
