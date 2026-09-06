# AYROVI — MASTER WORKFLOW IMPLEMENTATION PLAN

> Maps the **Master Order** (target behavior) onto the **existing codebase**
> (source of truth: `AYROVI_OPERATIONAL_WORKFLOW_AUDIT.md` 2026-09-06 +
> `AYROVI_OPERATIONAL_MODEL_DISCOVERY.md` + `docs/WORKER-OPERATIONAL-MODEL.md`).
>
> Rule applied (Order §0): **CLEAN FIRST**. Every change below is
> keep / refactor / extend — no second task system, no second receiving
> workflow, no second scanner core.

## 0. Environment constraints (verified 2026-09-06, sandbox)

| Capability | State | Consequence |
|---|---|---|
| Node 22 + npm | ✅ | Backend/frontend build & tests possible |
| PostgreSQL | via `embedded-postgres` (npm, real PG18 binaries) | E2E tests possible against a real DB |
| Render API / dashboard | ❌ no credentials, no network egress | Phase 15 = BLOCKED (reported per §40) |
| Java / Android SDK | ❌ none installable (egress restricted; GitHub release asset host blocked) | Phase 16/17 = BLOCKED (reported per §40) |
| CT40 hardware | ❌ not attached | Hardware tests B–E validated via API with `scanSource=EXTERNAL_SCANNER` (what a CT40 emits); real-hardware validation remains an open gate |

## 1. Dependency map (Phase 1 — architecture cleanup)

```
EXTERNAL CRM ──x-api-key──▶ integrations/crm/* (customer-cards, shipments, orders)
        │  idempotent: customerArrivalCardId / externalShipmentId / externalOrderReference(+contentHash)
        ▼
expected-arrivals.service.ts (receiveCard)     orders.service.ts (intake)     [EXISTING]
        │                                        │
        ▼                                        ▼
ExpectedArrival(WAR-) + items            WarehouseOrder + OrderItem + Product
        │
        ▼  [NEW] TaskDispatchService.dispatchReceiving  ← auto task (Order §3)
ReceivingService (ONE backend contract)  [EXISTING, kept]
  start / scanCarton / receiveCarton / receiveProduct / pause / resume /
  flag / resolve / complete / reportIssue
        │  (FulfillmentService.scanArticleAtReceiving = unit-level tote filling, [EXISTING])
        ▼
Receiving COMPLETE ──▶ [NEW] auto next-task (Order §9)
   per open tote      → receiving-container task (finish/close/stage)
   per closed tote    → sorting task
        ▼
FulfillmentService [EXISTING, extended]
  containers (RCN- capacity 50, auto-close at capacity, manual close)
  [NEW] POST /containers/:code/stage  → temporary storage station (Order §11)
  sorting (article → category zone location)            [EXISTING]
  order-sorting (article → customer BIN-)               [EXISTING]
  [NEW] customer container QR + LOCK on READY_FOR_PACKING (Order §15)
  [NEW] admin correction: REOPEN_CUSTOMER_BIN (audited)  (Order §15)
  packing (BIN- → OUT- READY_TO_SHIP)                   [EXISTING]
  [NEW] POST /shipping/verify (QR→customer→container→status, content hash, token) (Order §17)
  shipping (verify-bound dispatch)                      [EXISTING, hardened]
  [NEW] GET /shipping/bordereau/:code                   (Order §18)
        ▼
TaskDispatchService [NEW] — the ONLY auto-dispatcher (Order §9/§20)
  role + permission + station-department + warehouse + availability rules
  writes WorkerTaskAssignment (ONE task system, kept per Order §20)
        ▼
Admin Control Center (frontend/admin/*) [EXISTING, extended per Order §26]
Native Worker App (mobile/*, CT40 + Phone) [EXTENDED per Order §10/§11/§37]
```

### Duplicated/obsolete items disposition (Order §0/§22/§23/§28)

| Item | Decision |
|---|---|
| Native Receiving vs Web Terminal Receiving | **KEEP both surfaces, ONE backend contract** (already the case). Native = primary operational surface; Web terminal = admin/fallback. No code duplication on the backend. (Order §22) |
| `receive-product` (quantity count) vs `scan-article` (unit into tote) | **NOT a duplicate workflow** — two granularities of the SAME reconciliation, both idempotent via `ReceivingScanEvent`, both audited. Documented as the single product-receiving contract: count for quantity verification, scan for unit-level traceability/tote filling. (Order §23) |
| `WorkerTaskAssignment` | **KEPT as the only task system** (Order §20). No new task table. |
| `TASK_REGISTRY` (task-registry.ts) | **KEPT** as the task-type catalog; extended with NOT_IMPLEMENTED documentation. No generic workflow builder (Order §21). |
| `scanner-core` (mobile) | **KEPT** as scanner guard; no business logic added there (Order §25). |
| `PhysicalItem` (Phase-2 dormant piece model) | **KEPT dormant, explicitly NOT_IMPLEMENTED** — ArticleUnit is the operational piece model; no third model created (Order §36). |
| Picking / Inventory / Returns / Replenishment | **NOT_IMPLEMENTED** — no fake worker tasks; documented in registry + report (Order §36). |
| Stale branch `arena/01a07334` + releases | Verified via `gh` (merged? unique commits?) then documented; deletion only if fully merged (Order §28). |

## 2. Target end-to-end chain (implemented)

```
CRM customer-arrival-card ─▶ ExpectedArrival (idempotent) ─▶ AUTO receiving task
CRM shipment-card ─▶ Shipment + Cartons (idempotent)
CRM order-card ─▶ WarehouseOrder (idempotent) ─▶ AUTO order-sorting task (when goods exist)
  ▼
RECEIVING (task: receiving)
  worker sees operational cards (carton card / product card) — no reconstruction
  scan carton  → CARTON_IDENTIFIED → receive-carton (idempotent, operational errors)
  scan product → quantity reconcile (SKU/reference, case-insensitive normalization)
  scan article → unit into tote (capacity 50, auto-close, manual close)
  REPORT PROBLEM → discrepancy / operational exception (audited, visible in Admin)
  DONE/COMPLETE → COMPLETED | COMPLETED_WITH_DISCREPANCY (supervisor gate kept)
  ▼ AUTO NEXT TASK (Order §9)
CONTAINER / PLACEMENT (task: receiving-container)
  scan container → scan/fill products → 50/50 FULL auto-close OR manual close (27/50)
  stage → TEMPORARY STORAGE STATION (station → zone, config in Admin)
  ▼ AUTO NEXT TASK
SORTING (task: sorting) — articles in staged totes
  category storage (existing) and/or direct customer matching
  ▼
CUSTOMER SORTING (task: order-sorting)
  customer card (name/ref + expected products)
  scan product → SYSTEM matches order+customer+bin → worker places in customer bin
  wrong product → rejected + reportable
  complete → **CUSTOMER QR GENERATED** → **CARD LOCKED** (reopen = admin correction, audited)
  ▼ AUTO NEXT TASK
PACKING (task: packing) — verify bin completeness → pack → OUT- READY_TO_SHIP
  ▼ AUTO NEXT TASK
SHIPPING (task: shipping)
  SCAN customer-container QR → VERIFY customer → VERIFY container → VERIFY status → SHIP
  (verification bound to shipment + content hash + expiry — no unverified ship)
  ▼
BORDEREAU (shipping document) — Admin search by customer/order/shipment/QR → print
```

## 3. Phase execution order (mapped to repo)

| Phase | Work | Key files |
|---|---|---|
| 1 | Plan + dependency map + cleanup disposition | this file |
| 2 | Schema: Station.zoneId, STAGING dept, container staging fields, qrValue, ShippingVerification, OperationalException, audit actions, reopen-bin correction | `prisma/schema.prisma`, new migration, `bootstrap-schema-repair.ts` (PROD MIGRATION MECHANISM — must include new objects), `seed.ts` |
| 3 | CRM → auto receiving/order tasks | `expected-arrivals.service.ts`, `orders.service.ts`, NEW `assignments/dispatch.service.ts` |
| 4 | Receiving: normalization boundary, operational messages, arrival preview card, report-problem parity | `receiving.service.ts`, NEW `common/scan-normalizer.ts`, `receiving.controller.ts` |
| 5 | Container stage → temp station + auto sorting task | `fulfillment.service.ts`, `stations.service.ts`, `dispatch.service.ts` |
| 6 | Customer QR + lock + reopen correction + sorting exceptions | `fulfillment.service.ts`, `corrections.service.ts`, `operations.service.ts` |
| 7 | Packing board parity (existing pack flow kept) | `fulfillment.service.ts` |
| 8 | Shipping verify + bordereau + admin search | `fulfillment.service.ts`, `operations.service.ts` |
| 9 | Admin Control Center: arrivals board, containers+staging, bins+QR/lock, shipping+bordereau, unified exceptions, stations zone | `frontend/src/admin/*` |
| 10/11 | Native CT40 + Phone: container/sorting/packing/shipping lanes | `mobile/app/.../presentation/*`, `worker-core/.../WorkerRepository.kt` |
| 12 | Data cleanup/migration toolkit (safe, dry-run, backup/rollback) | NEW `tools/data-migration/*` |
| 13 | Full E2E test matrix (A–W where possible via API) | `backend/test/*.e2e-spec.ts` |
| 14 | git commit + push + PR | — |
| 15 | Render deployment | **BLOCKED — reported** |
| 16/17 | Android APK + GitHub Release | **BLOCKED — reported** (no JDK/SDK/signing in sandbox) |
| 18 | Final report `AYROVI_MASTER_WORKFLOW_IMPLEMENTATION_REPORT.md` | — |

## 4. Hard rules kept from the current system (MUST NOT CHANGE)

- Idempotency contracts: `customerArrivalCardId`, `externalShipmentId`,
  `externalCartonId`, `operationId` (cartons + `ReceivingScanEvent` units).
- Append-only ledgers: `CartonPlacement`, `OperationCorrection`, `ReceivingScanEvent`.
- Restrict/SetNull deletion policy; expected data immutable during receiving.
- Supervisor gate on closing a discrepant receiving.
- Worker never sees Admin; worker never writes workflow state directly.
- `bootstrap-schema-repair.ts` in-process self-repair (the ONLY mechanism
  proven to run in production regardless of Render Start Command).
- One task system (`WorkerTaskAssignment`), one scanner core, one
  permissions authority (RBAC re-read per request).

## 5. Decisions requiring business confirmation (open, non-blocking)

- Exact staging station codes/zones for production (config, not code) — Admin can set.
- Bordereau print layout details (label fields beyond customer/order/QR/contents).
- Whether `sorting` (category storage) stays part of the mandatory chain or is
  optional before customer sorting — current implementation allows both paths
  (articles may go tote → customer bin directly, or tote → storage → bin).
