# AYROVI — WORKFORCE + TASK ENGINE + OPERATIONAL WORKFLOW IMPLEMENTATION REPORT

**Phase 1 of the Worker Operational Model order — implementation report.**
Date: 2026-09-06 · Branch: `arena/01a074c7-core-wh`
Authoritative model reference: `docs/WORKER-OPERATIONAL-MODEL.md`
Discovery baseline: `AYROVI_OPERATIONAL_MODEL_DISCOVERY.md` (C-1..C-18)

---

## 1. Implemented (new)

### Backend
| Piece | Where | What it does |
|---|---|---|
| Shared task catalog | `src/modules/operations/task-registry.ts` | TASK_REGISTRY with `subtaskOf` (receiving-container is a sub-action of receiving); consumed by the terminal, assignments and admin boards |
| Assignments service | `src/modules/assignments/assignments.service.ts` | Operational assignment model: taskKey + authoritative entity links (arrival/carton/container/outbound/order/station), lifecycle ASSIGNED→IN_PROGRESS→COMPLETED(_WITH_DISCREPANCY)/BLOCKED/CANCELLED, work counters, worker issue reporting, station↔department policy (`WorkPolicyService`, §22) |
| Assignments API | `operations.controller.ts` | Admin: `GET/POST /operations/assignments(+ /cancel /block /unblock)`. Worker: `GET /terminal/work`, `GET /terminal/tasks`, `POST /terminal/issues`, `GET /terminal/issue-types` |
| Workflow↔assignment sync | receiving/putaway/fulfillment services | Session start → IN_PROGRESS; receiving complete / carton stored / bin packed / shipment dispatched → COMPLETED(_WITH_DISCREPANCY). All backend-driven, audited |
| Idempotency ledger (C-4) | `ReceivingScanEvent` (operationId unique) | receive-product + scan-article dedupe replays; migration + bootstrap repair included |
| Tote lifecycle (§20–21) | fulfillment service + `ContainerStatus.READY_FOR_SORTING` | n/capacity counter on every article scan, backend auto-close at capacity, manual `POST /fulfillment/containers/:code/close` at ANY count (no minimum) |
| Putaway claims (C-6) | putaway service + `WarehouseCarton.claimedById/claimedAt` | 10-min TTL soft claim, claim/release endpoints, queue hides other workers' fresh claims, claims clear on placement |
| Multi-surface guard (C-3) | `require-application.decorator.ts` + `application.guard.ts` | `@RequireApplication` accepts a list; explicit surfaces on receiving (WORKER_NATIVE), fulfillment (dual), expected-arrivals/orders/shipments (ADMIN_WEB) |
| WorkPolicyService (§22) | assignments module | Backend-enforced station department compatibility; no-station workers allowed; denials audited (UNAUTHORIZED_STATION_ACCESS) |
| Roles & seed (§3/§4) | `prisma/seed.ts` | RECEIVING_WORKER / SORTING_WORKER / PUTAWAY_WORKER / PACKING_WORKER / SHIPPING_WORKER (OPERATIONAL, no operations.view); INBOUND_WORKER becomes a documented compatibility role; seeded WORKER001 also gets the three inbound granular roles |
| Schema + migration | `schema.prisma`, migration `20260906120000_worker_operational_model` | All of the above, guarded/idempotent, with relatedType/relatedCode → FK backfills and Station.deviceId→Device conversion (C-8) |
| Bootstrap self-repair | `src/bootstrap-schema-repair.ts` | Mirrors the new migration (probe columns + guarded statements + ledger entry) |

### Frontend (Admin Web)
- **Assign task modal (§40)** (`Workers.tsx`): task type (from TASK_CATALOG) + entity code (WAR-/CTN-/RCN-/BIN-/OUT-) + optional station; backend resolves/validates.
- **Assigned registry**: operational statuses (ASSIGNED/IN_PROGRESS/BLOCKED/COMPLETED/COMPLETED_WITH_DISCREPANCY/CANCELLED), taskKey column, updated filters/tags.
- **Worker role options**: the five granular roles + compatibility labels.
- **Outbound Shipments (§31)**: per-row `print` of the dispatch note (bordereau) from authoritative backend data (QR = shipment code; carrier/tracking shown as INTERNAL/— because NullCarrierAdapter stays null).
- API surface moved to `/v1/operations/assignments` (+ block/unblock).

### Frontend (Worker Terminal)
- **Worker Home (§34)**: counters ASSIGNED TO ME / AVAILABLE FLOOR WORK / STARTED BY ME; per-task ASSIGNED/AVAILABLE/MINE badges; sub-actions render once per route.
- **REPORT ISSUE (§41/C-16)**: `ReportIssue` panel mounted in the shell strip → reachable on EVERY operational screen; the 9 issue types; opens a discrepancy when a receiving session is active.
- **Tote workflow**: per-unit `operationId` (C-4), n/50 counter feedback, backend-committed auto-close feedback, manual CLOSE TOTE.
- Feedback vocabulary gains a `warn` level (`beepWarning`) — audio never alone (visual banner always).

### Native app (CT40/phone)
- **C-1**: scan-carton now only identifies; success ("CARTON RECEIVED") shown only after the receive-carton commit returns; commit is idempotent (operationId).
- **C-2**: session state machine uses the backend statuses (RECEIVING/PAUSED) instead of a fictional ACTIVE.
- **C-4**: scan-article sends a per-scan operationId.
- **§21**: CLOSE TOTE button (manual close at any count).
- **§34**: station tiles use industrial monospace badges (RCV/TOT/SRT/BIN/PKC/SHP/TRC) — no emojis.

## 2. Migrated (behavior preserved)

| Before | After |
|---|---|
| `TASK_REGISTRY` hardcoded in terminal.service.ts | shared `task-registry.ts`; terminal.service re-exports for compatibility |
| WorkerTaskAssignment advisory (OPEN/DONE, relatedType/relatedCode strings) | operational lifecycle + real FKs; legacy strings kept as display echo; migration backfills FKs from the strings; legacy endpoints alias the new service |
| operations.service workerTaskCreate/Cancel/List | delegate to AssignmentsService (single writer) |
| `@RequireApplication('X')` single surface | list-based; all existing usages unchanged semantically |
| INBOUND_WORKER sole floor role | compatibility role (same permissions), granular roles added |
| Open-work counters absent | backend `workCounts()` from real rows (arrivals EXPECTED, my sessions, unclaimed RECEIVED cartons, IN_CONTAINER articles, READY_FOR_PACKING bins, READY_TO_SHIP shipments, stored articles matching OPEN order lines) |

## 3. Fixed (mandatory §46)

| Fix | Resolution |
|---|---|
| **C-1** native false-positive | commit before success (see above); web flow already committed first — verified |
| **C-2** native ACTIVE | backend statuses; hero label mirrors session status verbatim |
| **C-3** implicit surfaces | every workflow controller declares its surface; guard supports dual; e2e matrix extended |
| **C-4** duplicate unit events | ReceivingScanEvent ledger on receive-product + scan-article (web + native) |
| **C-5** shipping access | SHIPPING_WORKER role + shipping task in registry + terminal card + board print |
| **C-12** multi-shipment arrivals | carton validation is by ARRIVAL (all shipments), not the session's primary shipment |
| **C-16** no issue reporting | REPORT ISSUE everywhere (shell strip), 9 types, audited + discrepancy |
| C-6 putaway collisions | soft claims (TTL) |
| C-8 Station.deviceId | real Device relation + guarded code→UUID conversion |
| C-10 dead TOTE tab | tote sub-action is a real workflow: counters, auto-close, manual close; TRACE remains available via permitted tasks only |
| C-11 assignment↔workflow | schema FKs + lifecycle sync in the workflow services |
| C-13 offline honesty | no offline actions advertised; OfflineQueue stays an unwired envelope |

Debug vocabulary (LEGACY WORKFLOW / NOT MIGRATED / DEBUG) — none present in
worker UX (grep-verified); "Server error" fallbacks reworded.

## 4. Remaining (known, deliberate)

- **Damage workflow**: NOT implemented (needs business approval) — SHORTAGE/OVERAGE/etc. issue types cover reporting.
- **NOT implemented by explicit prohibition (§47)**: Transfer, Cycle Count, QC, Returns, Loading, Inventory picking.
- Offline execution: not offered anywhere; the envelope exists for a future approved design.
- e2e suite + Android build require a real PostgreSQL/Java environment — run `backend/test/isolation.e2e-spec.ts` (now 15 cases) and `./gradlew assembleDebug` in CI.
- `eslint` is referenced by package scripts but not installed as a dependency in this sandbox (pre-existing) — lint could not be executed here.
- Frontend `onnxruntime-node` native binding not installed (blocked network): OCR software-scanner runtime concern only; typecheck/tests/build green.

## 5. Tests & verification (this sandbox)

| Check | Result |
|---|---|
| `prisma validate` + `prisma generate` (stub engines) | ✅ |
| Backend `tsc --noEmit` | ✅ |
| Backend unit tests (jest) — **78 passed** incl. 13 new assignments/policy + 3 new guard dual-surface + updated terminal routing | ✅ |
| Backend production build (`nest build`) | ✅ |
| Frontend `tsc` + `vitest run` — 107 passed | ✅ |
| Frontend production build | ✅ |
| e2e isolation matrix | written (15 cases) — needs real DB (CI) |
| Android build | not runnable here (no Java) — code changes are additive |

## 6. Worker roles matrix

| Role | Tasks unlocked | operations.view? |
|---|---|---|
| RECEIVING_WORKER | receiving (+ tote sub-action) | NO |
| SORTING_WORKER | sorting | NO |
| PUTAWAY_WORKER | putaway | NO |
| PACKING_WORKER | packing | NO |
| SHIPPING_WORKER | shipping | NO |
| INBOUND_WORKER (compat) | receiving + sorting + putaway | NO |

## 7. Task matrix (registry → assignment entity)

| Task key | Entity for assignment | Completed by |
|---|---|---|
| receiving | ExpectedArrival (WAR-) | receiving session complete |
| receiving-container | OperationalContainer (RCN-) | tote close / session complete |
| sorting | OperationalContainer (RCN-) | manual (instruction) |
| putaway | WarehouseCarton (CTN-) | carton placed |
| order-sorting | OperationalContainer (BIN-) / WarehouseOrder | manual (instruction) |
| packing | OperationalContainer (BIN-) | pack |
| shipping | OutboundShipment (OUT-) | ship |

## 8. Station matrix (§22 backend enforcement)

| Station department | Tasks permitted at that station |
|---|---|
| RECEIVING | receiving (+ tote) |
| SORTING | sorting, order-sorting |
| PUTAWAY | putaway |
| PACKING | packing |
| DISPATCH | shipping |
| INVENTORY | (no operational task yet — future) |
| no station | all permitted tasks (station optional by design) |

## 9. Permission matrix (floor roles)

receiving.{view,execute} · stowing.{view,execute} · picking.{view,execute} ·
packing.{view,execute} · shipping.{view,execute} — per role as listed in §6.
Stations.{view,manage}, users.{view,manage}, operations.{view,correct} remain
admin-only. No floor role received operations.view (verified in seed).

## 10. State machines

**Assignment**: ASSIGNED → IN_PROGRESS → COMPLETED | COMPLETED_WITH_DISCREPANCY;
ASSIGNED/IN_PROGRESS ⇄ BLOCKED (admin); → CANCELLED (admin/worker removal).
**Receiving session**: RECEIVING ⇄ PAUSED → COMPLETED | COMPLETED_WITH_DISCREPANCY.
**Tote**: ACTIVE → READY_FOR_SORTING (capacity | manual close).
**Carton**: EXPECTED/ANNOUNCED → RECEIVED → STORED (claim transient).
**Article**: IN_CONTAINER → STORED → IN_CUSTOMER_BIN → PACKED → SHIPPED.
**Outbound**: READY_TO_SHIP → SHIPPED.

## 11. End-to-end chain (§50 acceptance)

ADMIN (Workers → Assign task: receiving + WAR-code + station) → backend
validates worker/task/entity, creates ASSIGNED (audited TASK_ASSIGNED) →
worker terminal home shows the assignment immediately → worker opens
receiving → backend starts session, assignment IN_PROGRESS → scan carton
(idempotent identify + commit), verify products/articles into tote (C-4
operationIds) → COMPLETE → backend COMPLETED(_WITH_DISCREPANCY), arrival
mirrored, exceptions visible in Admin Exception Center → next available work
appears (tote → sorting, cartons → putaway) → admin sees status, audit trail
and drill-down. No false success (C-1), no duplicate events (C-4), no
unauthorized execution (C-3/§22), CT40 receiving intact (C-1/C-2 fixed).
