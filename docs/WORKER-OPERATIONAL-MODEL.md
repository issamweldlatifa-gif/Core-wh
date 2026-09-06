# WORKER OPERATIONAL MODEL — Reference Documentation

> **Status: AUTHORITATIVE.** This document supersedes, for everything concerning
> workers / roles / permissions / stations / tasks / assignments / the worker
> terminal and the worker native app, the following older documents (kept for
> history, no longer normative):
>
> - `AYROVI_WAREHOUSE_FULL_DISCOVERY_AUDIT.md` (root) — superseded by
>   `AYROVI_OPERATIONAL_MODEL_DISCOVERY.md` and this document.
> - `docs/ADMIN-CONTROL-CENTER-*-*.md` — the Worker Control sections.
> - `docs/OPERATIONAL-FLOW-REPORT.md` — the assignment/task sections.
> - `docs/NATIVE-WORKER-APP-EXECUTION-PLAN.md` — the station/task sections.
>
> Discovery context (constraints C-1..C-18) remains in
> `AYROVI_OPERATIONAL_MODEL_DISCOVERY.md`.

---

## 1. The one operational model

```
ADMIN WEB                BACKEND (source of truth)              WORKER APP
Workers/Roles    ──►     TASK_REGISTRY (task-registry.ts)   ◄──  /terminal/context
Stations                 WorkerTaskAssignment                    Home + counters
Tasks             ──►     (taskKey + entity FK + status)    ◄──  /terminal/assignments
ASSIGN           ──►     POST /operations/assignments       ◄──  worker sees it immediately
                         workflow services drive the lifecycle
                         (start → IN_PROGRESS, complete → COMPLETED…)
```

The Worker app never decides task completion, carton validity or customer
ownership. It displays, scans, inputs, requests — and shows the backend verdict.

## 2. Worker roles (seed)

| Role | Class | Task key | Permission set |
|---|---|---|---|
| RECEIVING_WORKER | OPERATIONAL | receiving (+ receiving-container sub-action) | receiving.{view,execute}, expected_arrivals.view, shipments.view, structure view |
| SORTING_WORKER | OPERATIONAL | sorting | stowing.{view,execute}, structure view |
| PUTAWAY_WORKER | OPERATIONAL | putaway | stowing.{view,execute}, structure view |
| PACKING_WORKER | OPERATIONAL | packing | packing.{view,execute}, structure view |
| SHIPPING_WORKER | OPERATIONAL | shipping (C-5) | shipping.{view,execute}, structure view |
| INBOUND_WORKER (compatibility) | OPERATIONAL | receiving/sorting/putaway | union of the three above — kept, never deleted without migration analysis |

Multi-role assignment is allowed. **No floor role has `operations.view`** (§4):
admin oversight stays in Admin Web.

## 3. Task registry (backend `task-registry.ts`)

| key | label | route | permission |
|---|---|---|---|
| receiving | Receiving | /terminal/receiving | receiving.execute |
| receiving-container (sub-action of receiving) | Receiving Container/Tote | /terminal/receiving | receiving.execute |
| sorting | Sorting | /terminal/sorting | stowing.execute |
| putaway | Putaway | /terminal/putaway | stowing.execute |
| order-sorting | Order Sorting | /terminal/order-sorting | picking.execute |
| packing | Packing | /terminal/packing | packing.execute |
| shipping | Shipping | /terminal/shipping | shipping.execute |

`VERIFY CARTONS` and `VERIFY PRODUCTS` are the two sub-actions of the single
receiving session (`RECEIVING_SUBACTIONS`).

## 4. Assignment lifecycle (backend-owned)

```
ASSIGNED ──(receiving start / worker opens work)──► IN_PROGRESS
ASSIGNED | IN_PROGRESS ──(workflow completes)──► COMPLETED | COMPLETED_WITH_DISCREPANCY
ASSIGNED | IN_PROGRESS ──(admin)──► BLOCKED ──(admin)──► ASSIGNED
any open state ──(admin / worker removal)──► CANCELLED
```

The transitions are written **by the workflow services**, never by a client:

| Event (backend service) | Assignment update |
|---|---|
| ReceivingService.start | ASSIGNED → IN_PROGRESS (audit TASK_IN_PROGRESS) |
| ReceivingService.complete | → COMPLETED / COMPLETED_WITH_DISCREPANCY (mirrors session) |
| PutawayService.place | carton-linked assignments → COMPLETED |
| FulfillmentService.pack | container-linked assignments → COMPLETED |
| FulfillmentService.ship | outbound-linked assignments → COMPLETED |

A worker may close a plain instruction assignment themselves
(`POST /terminal/assignments/:id/complete` + note) — that is the manual path
for instruction-only tasks.

## 5. Admin API (surface ADMIN_WEB, permission `users.manage`)

- `GET /v1/operations/assignments?workerId&status&taskKey`
- `POST /v1/operations/assignments` — `{workerId, taskKey?, relatedType?, relatedCode?, title?, description?, stationId?}`.
  The backend resolves the code (WAR-/CTN-/RCN-/BIN-/OUT-/order ref) to the
  authoritative FK; unknown codes are rejected, never guessed.
- `POST /v1/operations/assignments/:id/cancel|block|unblock`
- Legacy `/v1/operations/worker-tasks*` remain as aliases over the same service.

## 6. Worker API (surface WORKER_NATIVE)

- `GET /v1/terminal/context` — identity, permitted tasks, station, resume.
- `GET /v1/terminal/work` — counters per task: `assigned` (to me) /
  `available` (floor) / `mine` (started/claimed by me). Real DB counts only.
- `GET /v1/terminal/assignments` + `POST /:id/complete`
- `POST /v1/terminal/issues` — REPORT ISSUE (§41): types SHORTAGE, OVERAGE,
  UNKNOWN_CARTON, WRONG_SHIPMENT, UNEXPECTED_PRODUCT, MISSING_PRODUCT,
  MISSING_CARTON, IDENTIFICATION_ERROR, OTHER. Always audited
  (WORKER_ISSUE_REPORTED); opens a ReceivingDiscrepancy when a session is given.

## 7. Putaway coordination (C-6)

Soft claim with 10-minute TTL on `WarehouseCarton.claimedById/claimedAt`:
- `POST /v1/putaway/cartons/:code/claim` / `:code/release`
- `/v1/putaway/queue` hides other workers' fresh claims, keeps mine
- a claim is coordination, never authority — it expires and clears on placement

## 8. Receiving tote lifecycle (§20–21)

- every article scan returns `containerCount/containerCapacity/containerFull`
- at capacity the backend auto-closes the tote (`READY_FOR_SORTING`) and audits it
- manual close at ANY count (no mandatory minimum):
  `POST /v1/fulfillment/containers/:code/close`

## 9. Idempotency (C-4)

`ReceivingScanEvent` (operationId unique) is the ledger for unit-level scans:
`receive-product` and `scan-article` accept an `operationId`; replays return
the session state without a second write.

## 10. Station ↔ device ↔ role (C-8, §22)

- `Station.deviceId` is a real `Device` FK (guarded migration maps legacy codes).
- Department compatibility is backend-enforced (`WorkPolicyService`): a worker
  bound to an ACTIVE station may only execute that station's department; no
  station → allowed (station-less devices must not be blocked).

## 11. Surfaces (C-3)

Every operational controller declares its application surface:
- WORKER_NATIVE: terminal, receiving, putaway
- ADMIN_WEB: operations, stations, users, roles, permissions, devices, audit,
  categories, system, warehouse structure, expected-arrivals, orders, shipments
- Dual (WORKER_NATIVE + ADMIN_WEB): fulfillment (workers scan; admin
  traceability board reads)

`@RequireApplication` now accepts several surfaces; the guard rejects any
session whose application (or roles) does not match, and audits denials.

## 12. Offline honesty (C-13)

No operational action is available offline. The worker UI shows OFFLINE in the
strip; scans fail loudly. The in-memory OfflineQueue in the native scanner-core
is an envelope model for a future approved implementation — it is NOT wired to
any screen and advertises nothing.
