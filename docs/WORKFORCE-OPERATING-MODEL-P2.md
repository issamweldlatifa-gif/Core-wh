# AYROVI Warehouse Core — Workforce Operating Model
## Reference document (PARTIE 2 — WORKFORCE OPERATING MODEL)

> **Status:** Approved-by-command reference · **Phase:** Partie 2 (model only — no UI redesign, no new
> Worker screens, no workflow re-architecture). This document is the durable contract that
> **Partie 3 — Stations + Worker Terminal Architecture** must build on.
> Companion delivery report: `docs/WORKFORCE-OPERATING-MODEL-P2-FINAL-REPORT.md`.

---

## 0. Scope statement

This phase **installs and documents the operating model** that links

```
ROLE → WORKER → STATION → TASK → PERMISSION → OPERATION
```

It does **not** redesign screens, terminals or dashboards. Where the current architecture already
implements the model (stations, RBAC, receiving→tote→bin→pack→ship), this document pins it down.
Where it conflicts with the AYROVI source-of-truth flow, the conflict is **recorded**, not silently
worked around, and any corrective change is explicitly deferred to a later, approved phase.

---

## 1. Source of truth — the AYROVI Warehouse Operational Flow

```
ARRIVAL
  → RECEIVING                 (carton received, article scanned)
  → RECEIVING CONTAINER/TOTE  (operational buffer on the receiving line)
  → CUSTOMER SORTING          (article → customer/order, NOT by category)
  → CUSTOMER BIN              (one bin per open order)
  → PACKING                   (only when the order is complete)
  → OUTBOUND SHIPMENT
  → SHIPPING                  (exactly once per shipment)
  → ARCHIVE / TRACE           (never deleted)
```

**Canonical semantics (binding):**
- **Category = Product Information**, not an operational stage. A missing/unconfirmed category must
  never stall receiving, binning, packing or shipping.
- **Receiving Container / Tote = an operational buffer** on the receiving line (a scan destination),
  with a configurable capacity.
- **Customer Order = the fulfillment destination**; Customer Sorting and Customer Bins are anchored
  to the order, never to the category.
- `Product → Category → Storage` is **NOT** a mandatory AYROVI workflow. (See §9 C6: a category-zone
  storage path exists in the codebase from an earlier design — it is recorded as legacy and left in
  place, untouched.)

---

## 2. Roles — technical (database) vs conceptual (domain)

Rules honoured: no existing role deleted; no new role created only because a proposed name differs;
technical names kept for compatibility; domain mapping documented here.

### 2.1 Role registry (live database)

7 roles exist (all `isSystem = true`), 265 role→permission grants, 74 permissions.

| Technical role (DB) | Conceptual (domain) label | Role in the operation |
|---|---|---|
| `SUPER_ADMIN` | SUPER ADMIN — full system administration | Everything incl. users/roles/api/system management |
| `WAREHOUSE_ADMIN` | ADMIN — warehouse operations management | Admin Control Center: correct/void, manage stations, manage workers, all `*.execute` |
| `WAREHOUSE_MANAGER` | MANAGER — warehouse operations supervision | Supervision + corrections (`operations.correct`), all `*.execute`, view stations/audit; no user/role/system management |
| `INBOUND_WORKER` | INBOUND WORKER — Receiving | `receiving.execute` (+ today also `stowing.execute` — see §8/§9 C1) |
| `PICKER` | SORTING WORKER — Customer Sorting | `picking.execute` → today's **Order Sorting** task is the customer-sorting step |
| `PACKER` | PACKER — Packing | `packing.execute` |
| `VIEWER` | VIEWER — read-only monitoring | All `.view` (+ `audit.view`), zero `.execute/.manage` |

### 2.2 Conceptual role coverage — gaps

| Conceptual role (command §03) | Covered by | Notes |
|---|---|---|
| INBOUND WORKER | `INBOUND_WORKER` | ✅ present |
| SORTING WORKER | `PICKER` | ⚠️ name mismatch: the *terminal task* that performs customer sorting is **Order Sorting** (`picking.execute`). See C3. |
| PACKER | `PACKER` | ✅ present |
| SHIPPING WORKER | — | ❌ **no floor role carries `shipping.execute` today** (only admin/manager/super). See C2. |
| ADMIN | `WAREHOUSE_ADMIN` | ✅ present |
| MANAGER | `WAREHOUSE_MANAGER` | ✅ present |
| SUPER ADMIN | `SUPER_ADMIN` | ✅ present |
| VIEWER | `VIEWER` | ✅ present |

> No role was created, renamed or deleted in this phase. Fixing C2/C3 is a role-design decision for
> the next approved phase, because granting/removing permissions changes who may do what on the floor.

---

## 3. Worker model & current mapping

**Model:** every worker resolves to `Worker (User) → Role(s) → Station → Current task → Status →
Last activity`. Worker status follows the Command #3 semantics: `ACTIVE` (can sign in),
`LOCKED` (blocked, reversible), `DISABLED` (removed, permanent, account kept).

### 3.1 Current workers (local dev database, 2026-09-03)

| Employee | Name | Roles | Station | Status | Worked today (derived) |
|---|---|---|---|---|---|
| `WORKER001` | Ahmed Ben Salah | INBOUND_WORKER | ST-REC-01 (assigned) | ACTIVE | derived from real sessions |
| `ADMIN001` | System Administrator | SUPER_ADMIN | — (not a worker surface) | ACTIVE | — |

*(Three `TSTC3…` accounts appear as `DISABLED` — they are Command #3 acceptance fixtures created
through the real Admin UI to prove soft removal; they are kept (never hard-deleted) and flagged as
QA artifacts, not operational staff.)*

### 3.2 Workers observed in production (from the pre-engagement audit, same date)

| Employee | Roles | Status | Note |
|---|---|---|---|
| `Isco` | SUPER_ADMIN | ACTIVE | admin |
| `23282716` | WAREHOUSE_ADMIN | ACTIVE | admin |
| `123456` | PICKER | ACTIVE | floor |
| `1234567` / `WORKER001` | INBOUND_WORKER | ACTIVE | floor |
| `1234`, `12345` | *(no roles)* | ACTIVE | role-less accounts; listed as workers (not back-office) — flag to resolve |

---

## 4. Stations — current mapping

**Model:** `Station { id, code, name, department(type), status, assignedWorker, deviceId,
capabilities, warehouse }`. Five stations, matching the requested layout 1:1 — **no station added**.

| Station | Department (type) | Status | Assigned worker | Worker terminals allowed by the model |
|---|---|---|---|---|
| ST-REC-01 | RECEIVING | ACTIVE | WORKER001 | Receiving (+ tote scanning) |
| ST-REC-02 | RECEIVING | ACTIVE | — | Receiving (+ tote scanning) |
| ST-SRT-01 | SORTING | ACTIVE | — | Customer Sorting (today: Order Sorting task) |
| ST-PCK-01 | PACKING | ACTIVE | — | Packing |
| ST-SHP-01 | DISPATCH | ACTIVE | — | Shipping |

**Station live attributes** — “Current task / current container / last activity” are **derived at
read-time** from sessions and operational containers (admin boards), not duplicated as stored
columns. Station capabilities (`CAMERA`, `BARCODE_SCANNER`, `QR_SCANNER`, `OCR`, `PRINTER`, `SCALE`)
are **input affordances only** — the workflow never branches on them.
**Note (C5):** task *execution* is gated by **permission**, and station assignment is a soft link
(`assignedWorkerId`). The backend does **not** refuse a task because a worker sits at a station of
the wrong department. See §9 C5.

---

## 5. Task registry — current mapping (single registry, no second task system)

Single registry `TASK_REGISTRY` in `TerminalService`; each entry: key, label, path, department,
permission, ready. Nothing renamed — IDs/routes/permissions stay byte-compatible.

| Task key | Label | Terminal path | Dept | Permission | AYROVI flow step | Role(s) that see it today | Note |
|---|---|---|---|---|---|---|---|
| `receiving` | Receiving | `/terminal/receiving` | RECEIVING | `receiving.execute` | RECEIVING + RECEIVING TOTE | INBOUND_WORKER (+admins) | Article scan lands in tote |
| `sorting` | Sorting | `/terminal/sorting` | SORTING | `stowing.execute` | — (category-zone **storage** variant) | INBOUND_WORKER (+admins) | **Not in the AYROVI flow**; see C1/C6 |
| `putaway` | Putaway | `/terminal/putaway` | PUTAWAY | `stowing.execute` | — (carton stow legacy) | INBOUND_WORKER (+admins) | Not in the AYROVI flow; see C6 |
| `order-sorting` | Order Sorting | `/terminal/order-sorting` | SORTING | `picking.execute` | **CUSTOMER SORTING** | PICKER (+admins) | Article → customer/order → **Customer Bin** |
| `packing` | Packing | `/terminal/packing` | PACKING | `packing.execute` | PACKING | PACKER (+admins) | Completeness gate |
| `shipping` | Shipping | `/terminal/shipping` | DISPATCH | `shipping.execute` | SHIPPING | *(no floor role)* admins/managers | See C2 |

Worker Task Assignments (Command #3) are a **second, manager-issued** instruction layer
(`worker_task_assignments`) that **sits on top of** the registry and shows in every worker terminal;
they are not a competing task-kind architecture.

### API permission map (server-enforced)

| Operation | Route prefix | Permission |
|---|---|---|
| Containers create / tote or bin | `POST /fulfillment/containers` | `receiving.execute` |
| Containers list/get | `GET /fulfillment/containers…` | `receiving.view` |
| Article scan @ receiving → tote | `POST /fulfillment/receiving/sessions/:id/scan-article` | `receiving.execute` |
| Sorting (store by category-zone) scan/store | `…/sorting/articles/:code`, `…/sorting/store` | `stowing.execute` |
| Order sorting (customer sorting) scan/assign | `…/order-sorting/…` | `picking.execute` |
| Packing get/pack | `…/packing/…` | `packing.execute` |
| Shipping get/ship | `…/shipping/…` | `shipping.execute` |
| Workers board / detail | `GET /operations/workers…` | `operations.view` |
| Worker block/unblock/remove & task registry | `/operations/workers/:id/*`, `/operations/worker-tasks*` | `users.manage` |
| Receiving sessions | `/receiving/…` | `receiving.execute` / `receiving.resolve_discrepancy` |
| Putaway | `/putaway/…` | `stowing.execute` |

---

## 6. Permission catalogue (74 keys, grouped)

Operational/floor-visible keys: `receiving.execute|view|resolve_discrepancy`, `stowing.execute|view`,
`picking.execute|view`, `packing.execute|view`, `shipping.execute|view`, plus read `*.view` for
orders/items/physical items/products/shipments/stations/locations/racks/levels/aisles/zones/warehouses/inventory/expected_arrivals.
Management keys: `users.manage|view`, `roles.manage|view`, `stations.manage|view`,
`system.manage|view`, `api_clients.manage|view`, `inventory.manage`, `operations.correct|view`,
`audit.view`, `warehouse_orders.*`, `order_items.*`, `physical_items.*`, `products.*`,
structure `*.create|update|activate|deactivate` (warehouses/zones/aisles/racks/levels/locations).

**Worker roles carry zero `*.manage` / zero `operations.correct` / zero `users.*` / zero
`roles.manage` / zero `system.manage` grants** → a worker cannot reach admin surfaces (verified by
test in the delivery suite and by the existing auth e2e 403 cases). The only worker-level `execute`
permissions are the four task families + `receiving.resolve_discrepancy` (supervisor-audited action).

---

## 7. Container model & lifecycle

Operational containers are **configuration-driven rows**, never hard-coded constants.

| Attribute | Value / rule |
|---|---|
| `code` | unique, scannable QR (`RCN-…` receiving tote / `BIN-…` customer bin) |
| `type` | `RECEIVING` (tote) · `CUSTOMER` (customer bin) — sized variants SMALL/STANDARD/LARGE are a **future extension**, not added now |
| `capacity` | **column with default 50, overridable per container** (1..100000, validated). FULL is **derived** (`count >= capacity`), never stored |
| `label` | big human label (e.g. customer name on a bin) |
| `orderId` | CUSTOMER bins bound to **one** order; one ACTIVE bin per open order enforced |
| `status` lifecycle | `ACTIVE` → (bins) `READY_FOR_PACKING` → `PACKED` → `CLOSED`; `VOIDED` kept for audit |

**Article unit lifecycle** (per-piece): `RECEIVED → IN_CONTAINER → [STORED] →
IN_CUSTOMER_BIN → PACKED → SHIPPED`, `VOIDED` kept. `STORED` reflects the legacy category-zone
storage branch only; the AYROVI flow ends binning at the Customer Bin. Articles are **never**
returned to their source carton (carton stays provenance only). Traceability is never deleted.

---

## 8. Role → Task matrix (desired vs today)

| Conceptual role | Desired task(s) | Today (terminal task keys visible) | Status |
|---|---|---|---|
| INBOUND WORKER | RECEIVING | `receiving` **+ `sorting` + `putaway`** (because INBOUND_WORKER also holds `stowing.execute`) | ⚠️ superset — see C1 |
| SORTING WORKER | CUSTOMER_SORTING | `order-sorting` (PICKER holds `picking.execute`) | ✅ under technical name PICKER |
| PACKER | PACKING | `packing` | ✅ |
| SHIPPING WORKER | SHIPPING | *(none)* | ❌ C2 |
| ADMIN / MANAGER / SUPER ADMIN | Monitoring / management | Admin Control Center (never routed to the terminal) | ✅ |
| VIEWER | Read-only | no terminal tasks | ✅ |

### Station → Task (logical) matrix

| Station type | Allowed task keys |
|---|---|
| RECEIVING | `receiving` |
| SORTING | `order-sorting` (customer sorting); legacy `sorting` exists on SORTING bench |
| PACKING | `packing` |
| DISPATCH | `shipping` |

---

## 9. Task/Worker lifecycles & execution principle

**Manager-issued assignment lifecycle** (`worker_task_assignments`): `OPEN → DONE` (worker,
self-scoped, optional note) or `OPEN → CANCELLED` (admin, reason; auto-cancelled on worker remove).
**Operational task lifecycles already live in the engine:**
Receiving session `RECEIVING/PAUSED → COMPLETED[_WITH_DISCREPANCY]/CANCELLED`; Putaway session
`ACTIVE/PAUSED → COMPLETED/CANCELLED`; Discrepancy `OPEN → RESOLVED/REJECTED`; Customer bin and
Outbound shipment transitions in §7 above.

**Execution principle (every worker task):** `SCAN → SYSTEM DECISION → ACTION → CONFIRMATION → NEXT`.
Concrete specs pinned by the model:

- **Receiving:** SCAN CARTON → SCAN ARTICLE → SYSTEM VALIDATION (expected line / overage /
  unexpected) → PLACE IN RECEIVING TOTE (scan container) → CONFIRM → NEXT ARTICLE.
- **Customer Sorting:** SCAN ARTICLE → SYSTEM identifies customer + order line → SHOW CUSTOMER BIN →
  WORKER PLACES ARTICLE → CONFIRM BIN → NEXT ARTICLE. Decisions (which customer/order/bin) come from
  the system; the worker only executes.

**Worker operational state:** presence is **derived** (no invented stored state): a worker is
ACTIVE-on-floor when an operational session is open or an activity occurred today; PAUSED when a
session is PAUSED; otherwise idle/offline by last-activity heuristics. The Command #3 Workers page
shows exactly that. No new state machine added.

---

## 10. Business rules — status board

| # | Rule | Implemented today | Where / evidence |
|---|---|---|---|
| 1 | Worker sees only tasks inside his permissions | ✅ server-enforced | `TASK_REGISTRY` filter + `@RequirePermissions` + new e2e |
| 2 | Worker does not run a task from a disallowed station *(if station enforcement active)* | ⚠️ **not enforced** server-side (permission-gated only) | C5 — deferred decision |
| 3 | Article never stalls on an unconfirmed category | ✅ at receiving/bin/pack/ship | `categoryStatus NEEDS_REVIEW` rides along; only legacy **storage** (`sorting/store`) refuses NEEDS_REVIEW → C6 |
| 4 | Receiving article → Receiving Container/Tote | ✅ | scan creates article `IN_CONTAINER` in the scanned tote |
| 5 | Product never returns to its original carton | ✅ | carton link is provenance only |
| 6 | Customer Sorting by Customer Order, not Category | ✅ | order-sorting matches SKU → order line → bin |
| 7 | Customer Bin bound to one open order | ✅ | one ACTIVE bin per order enforced |
| 8 | Packing blocked while order incomplete | ✅ | completeness gate in `packing` |
| 9 | No double shipping of one Outbound Shipment | ✅ | `SHIPPED` guard rejects re-dispatch |
| 10 | Traceability never deleted | ✅ | soft states + audit, append-only |

---

## 11. Conflicts & decisions (recorded, not silently fixed)

| ID | Finding | Disposition in Partie 2 |
|---|---|---|
| C1 | Terminal **Sorting** task uses `stowing.execute`, and `INBOUND_WORKER` also holds `stowing.execute` → an inbound worker sees `receiving + sorting + putaway`, a superset of the desired INBOUND→RECEIVING matrix. | **Recorded.** Fixing requires a permission/role or registry decision (Partie 3+). No change now. |
| C2 | No floor role can ship: `shipping.execute` is granted only to SUPER_ADMIN/WAREHOUSE_ADMIN/WAREHOUSE_MANAGER. No `SHIPPING_WORKER` role exists. | **Recorded.** Creating/granting is a role decision for a later phase. No change now. |
| C3 | “SORTING WORKER” concept ≠ terminal “Sorting”. Customer sorting is implemented by the **Order Sorting** task under `PICKER`/`picking.execute`. Naming overlaps (Sorting vs Order Sorting). | **Recorded; mapping table §5/§8 is authoritative.** |
| C4 | Role-less ACTIVE accounts exist in prod (`1234`, `12345`) and are treated as floor workers. | **Recorded.** Decide scope in a later phase. |
| C5 | Station assignment is a soft link; station department does **not** gate task execution server-side; station capabilities don't drive logic. | **Recorded.** Candidate Partie 3 hardening (station-aware task gating) — needs approval. |
| C6 | A category→zone **storage** branch exists (`sorting/store`, putaway) that refuses `NEEDS_REVIEW` articles and is not part of the AYROVI flow. | **Recorded as legacy; untouched.** Do not resurrect Category→Storage as mandatory. |
| C7 | Terminal tasks `sorting`, `putaway` have no home in the AYROVI flow. | Kept for compatibility; removal/relabel deferred. |
| C8 | Container sizing is per-row `capacity` (default 50). SMALL/STANDARD/LARGE container types are not modelled. | 50 is configuration (column), not a code constant ✅. Sizes deferred as future extension. |
| C9 | No stored worker IDLE/ACTIVE/PAUSED/OFFLINE state machine; presence is derived. | **Recorded.** Adding a state machine is a Partie 3 decision. |
| D1 | Keep all technical role/task/permission names (compatibility), express the domain model via this document's mapping. | ✅ decision. |
| D2 | This phase changes **no** role, permission, workflow, UI or schema. | ✅ decision (tests pin the current behaviour instead). |

---

## 12. Artifacts

- This reference document.
- Delivery report `docs/WORKFORCE-OPERATING-MODEL-P2-FINAL-REPORT.md`.
- Test suite `backend/test/operating-model.e2e-spec.ts` (role/permission/task/station/lifecycle/
  container/category checks, HTTP + service level) — ran green together with the existing
  `auth`, `category`, `receiving`, `operational-flow`, `schema-constraints`, `warehouse-structure`
  e2e suites.
