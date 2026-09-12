# AYROVI — Admin Web Organization Audit & Restructuring Plan (COMMAND 01)

Date: 2026-09-12 · Branch: `arena/01a096b8-core-wh` · Base: `75953c0`

> **Scope:** Admin Web only (`frontend/src/admin/*` + the `/admin` route tree).
> The Worker App (`mobile/`, `/terminal/*`) and the new Batch workflow are
> **inventoried but NOT modified**. No database, API, permission, or schema
> change was made.
>
> **Status of this document:** audit + proposed structure + one completed
> non-breaking navigation correction (AUD-01). All further structural
> changes are listed in the implementation plan and **wait for approval**.

---

## 1. Executive summary

The Admin Web is a single dedicated workspace at `/admin` (its own
`AdminShell` with header + grouped sidebar), fronting one NestJS backend.
Its structure is already clean at the **data level**: one overview
endpoint, one task registry, one assignment service, one correction path,
and strict RBAC + application-surface gates.

The accumulation is at the **navigation and legacy-alias level**:

1. **AUD-01** — one live screen (`/admin/corrections`) had no entry point
   anywhere in the UI (orphaned route). **Fixed in this command** (nav entry
   only — no new route, page, or logic).
2. **AUD-03** — the Workers page still calls the *legacy*
   `/operations/worker-tasks` alias although the backend documents
   `/operations/assignments` as the canonical surface (same service).
3. **AUD-02** — Control Center (overview) and the Operations page both
   render the same Pipeline + Operations panels (by-design overlap,
   consolidation candidate).
4. **AUD-05** — two user-creation forms (`/users` and Workers "Add worker")
   over one backend endpoint (different audiences; keep, document).
5. **AUD-07** — sidebar groups (`CONTROL/WORKFORCE/WAREHOUSE/FULFILLMENT/
   MONITORING/SYSTEM`) do not match the operational responsibilities
   (Tasks / Operations / Stations / Control); several items sit in the
   wrong group (e.g. *Receiving Workers* report under WAREHOUSE).
6. **AUD-06/11** — one stale UI copy line and one stale status doc.

No duplicate routes, no duplicate components, no parallel management
systems were found. Every screen is backed by a real backend endpoint and a
real permission. Nothing was deleted.

---

## 2. Delivery 1 — Complete inventory of existing Admin screens & routes

### 2.1 Admin Control Center route tree (`/admin`, own shell — `AdminShell.tsx`)

The whole tree is gated by `PermissionGate perm="operations.view"` and
`SurfaceGate surface="ADMIN_WEB"` in `App.tsx` (Order #3 isolation —
worker sessions are redirected to `/terminal`, never see this tree).

| Route | Screen | Component | Perm gate | Primary API |
|---|---|---|---|---|
| `/admin` | Control Center (overview) | `admin/pages/ControlCenter.tsx` | `operations.view` | `GET /v1/operations/overview` (30s shell poll, shared via Outlet context) |
| `/admin/operations` | Operations | `admin/pages/Operations.tsx` | `operations.view` | shared overview payload |
| `/admin/workers` · `/admin/workers/:id` | Workers — Worker Control (COMMAND #3) | `admin/pages/Workers.tsx` | page: `operations.view` · actions: `users.manage` | `GET /v1/operations/workers(/:id)`, `POST /v1/users`, `POST /v1/operations/workers/:id/{block,unblock,remove}`, `GET/POST /v1/operations/worker-tasks*` (legacy alias), `POST /v1/operations/assignments` (not yet used by UI) |
| `/admin/sessions/:id` | Session drill-down (+ verification report panel) | `admin/pages/SessionDetail.tsx` | `operations.view` | `GET /v1/operations/sessions/:id`, `GET /v1/operations/corrections`, `GET /v1/operations/receiving-reports(/:id)`, review/close POSTs |
| `/admin/stations` | Station registry + worker assignment + zone config (S10/S11) | `admin/pages/Stations.tsx` | `stations.view` / `stations.manage` | `GET/POST /v1/stations`, `PATCH /v1/stations/:id`, `POST .../status`, `.../assign`, `GET /v1/warehouses`, `GET /v1/zones` |
| `/admin/devices` | Device registry (WORKER_NATIVE hardware binding, Order #3) | `admin/pages/Devices.tsx` | `stations.view` / `stations.manage` | `GET/POST /v1/devices`, `POST /v1/devices/:id/{status,assign}` |
| `/admin/tasks` | Task registry + live floor counts | `admin/pages/Tasks.tsx` | `operations.view` | `GET /v1/operations/tasks` |
| `/admin/exceptions` | Exception Center (resolve = audited correction) | `admin/pages/Exceptions.tsx` | `operations.view` / `operations.correct` | `GET /v1/operations/exceptions`, `POST /v1/operations/corrections/resolve-exception` |
| `/admin/corrections` | Corrections ledger (append-only, before/after snapshots) | `admin/pages/Corrections.tsx` | `operations.view` | `GET /v1/operations/corrections` |
| `/admin/activity` | Live Activity feed (filterable, 15s poll) | `admin/pages/Activity.tsx` | `operations.view` | `GET /v1/operations/activity` |
| `/admin/live` | Live Wallboard (TV/manager display, SSE + 5s fallback) | `admin/pages/LiveBoard.tsx` | `operations.view` | `GET /v1/live/events` (SSE, `modules/system/live.controller.ts`) |
| `/admin/traceability` | Traceability chain (article → … → shipment) | `admin/pages/Traceability.tsx` | `operations.view` | `GET /v1/fulfillment/articles(/:code/trace)` |
| `/admin/data-control` | Data Control (soft-void + double-confirmed force delete) | `admin/pages/DataControl.tsx` | `operations.view` / `operations.correct` | `GET/POST /v1/operations/data-control/*` |
| `/admin/receiving-containers` | Receiving Containers / Totes board | `admin/pages/ReceivingContainers.tsx` | `operations.view` | `GET /v1/operations/receiving-containers` |
| `/admin/temporary-storage` | Temporary Storage (stations, capacity, review lane, Rapports de Fin) | `admin/pages/TemporaryStorage.tsx` | `operations.view` / `stations.manage` | `GET/PUT /v1/temporary-storage/admin/*` |
| `/admin/batches` | AYROVI Batch board (Phase 2; gated by `batch.enabled` flag, OFF by default) | `admin/pages/Batches.tsx` + `admin/batches.ts` | `batch.view` (+ `batch.accept/send/void` actions) | `/v1/batches/*` (isolated controller) |
| `/admin/receiving-workers` | Receiving Workers report (per-physical-operation log) | `admin/pages/ReceivingWorkers.tsx` | `operations.view` | `GET /v1/operations/receiving-workers` |
| `/admin/customer-bins` | Customer Bins board (reopen = audited correction) | `admin/pages/CustomerBins.tsx` | `operations.view` | `GET /v1/operations/customer-bins`, `POST /v1/operations/corrections/reopen-customer-bin` |
| `/admin/orders` | Orders board (read-only; orders arrive via integration endpoint only) | `admin/pages/Orders.tsx` | `operations.view` | `GET /v1/orders(/:ref)` |
| `/admin/shipments` | Outbound Shipments board (read-only; dispatch is worker-terminal only) | `admin/pages/OutboundShipments.tsx` | `operations.view` | `GET /v1/fulfillment/outbound-shipments` |
| `/admin/containers/:code` | Container detail (contents + full provenance) | `admin/pages/ContainerDetail.tsx` | `operations.view` | `GET /v1/operations/containers/:code` |
| `/admin/containers` | legacy alias → `/admin/receiving-containers` | redirect | — | — |
| `/admin/arrivals` | legacy alias → `/expected-arrivals` (global) | redirect | — | — |
| `/admin/receiving` | legacy alias → `/admin/operations` | redirect | — | — |
| `/admin/structure` | legacy alias → `/warehouse/structure` (global) | redirect | — | — |
| `/admin/users` · `/admin/roles` · `/admin/audit` · `/admin/system` | legacy aliases → global-shell pages | redirect | — | — |

Supporting (non-route) components:
`admin/api.ts` (typed admin client + `TASK_CATALOG` + `WORKER_ROLE_OPTIONS`),
`admin/controlData.ts` (single shared overview payload via Outlet context),
`admin/batches.ts` (batch client + pure `batchActions()` UI matrix),
`admin/temp-storage.ts` (temp-storage admin client),
`admin/pages/useAsync.ts`, `admin/pages/CorrectionDialog.tsx`
(single correction dialog: mandatory reason, original state shown,
history preserved — used by Exceptions / SessionDetail / CustomerBins /
DataControl).

### 2.2 Admin-relevant screens OUTSIDE `/admin` (global shell, `GlobalShell.tsx`)

These are admin functionality reachable from the admin sidebar via
`external` links or from `/admin/*` legacy aliases:

| Route | Screen | Component | Perm |
|---|---|---|---|
| `/` | Dashboard (monitor + navigate, links into `/admin`) | `pages/Dashboard.tsx` | session |
| `/profile` | Profile & permissions (identity) | `pages/Profile.tsx` | session |
| `/users` | Staff accounts (create/list) | `pages/Users.tsx` | `users.view` / `users.manage` |
| `/roles` | Roles & permissions | `pages/Roles.tsx` | `roles.view` / `roles.manage` |
| `/audit` | System audit log | `pages/Audit.tsx` | `audit.view` |
| `/system` | System settings + API clients + health | `pages/System.tsx` | `system.view` |
| `/expected-arrivals` | Expected Arrivals (CRM arrival cards) | `modules/expected-arrivals/ExpectedArrivals.tsx` | `expected_arrivals.view` |
| `/categories` | Category master + category→zone sorting config | `modules/categories/Categories.tsx` | `inventory.view` / `inventory.manage` |
| `/warehouse` (structure/warehouses/zones/aisles/racks/levels/locations) | Physical structure | `modules/warehouse/*` | `warehouses.view` + granular `*.view` |

### 2.3 Worker-terminal surfaces (WORKER_NATIVE — inventoried, out of scope)

`/terminal` (task picker), `/terminal/receiving(+report/:sessionId?)`,
`/terminal/putaway`, `/terminal/sorting`, `/terminal/order-sorting`,
`/terminal/packing`, `/terminal/shipping`, `/terminal/temporary-storage`.
Gated by `SurfaceGate surface="WORKER_NATIVE"` + per-task execute
permissions (`receiving.execute`, `stowing.execute`, `picking.execute`,
`packing.execute`, `shipping.execute`). Admins never execute here —
oversight is via the Control Center (by design, §46).
Receiving legacy paths `/receiving` and `/warehouse/receiving` redirect to
`/terminal/receiving`.

### 2.4 Current admin sidebar (source of truth: `AdminShell.tsx` `NAV`)

```
CONTROL      Overview (/admin) · Operations
WORKFORCE    Workers · Stations · Devices · Tasks
WAREHOUSE    Warehouse Tree↗ (ext /warehouse/structure) · Receiving
             Containers · Temporary Storage · Batches · Receiving Workers ·
             Categories↗ (ext /categories)
FULFILLMENT  Orders · Customer Bins · Shipments
MONITORING   Exceptions · Live Activity · Live Wallboard · Audit / Trace ·
             Data Control
SYSTEM       Settings↗ (ext /system)
```

Header strip (always visible): warehouse code · warehouse status · system
status · role · open-alert count · clock · user menu (Profile / Logout).

---

## 3. Delivery 2 — Current vs proposed navigation structure

**Principle:** no new modules, no new routes, no new components — only
group labels and item placement change (pure `NAV` data). Every current
route, permission gate, legacy alias and external link is preserved.

| Group (current) | Items (current) | Group (proposed) | Items (proposed) |
|---|---|---|---|
| CONTROL | Overview · Operations | **CONTROL** | Overview · Operations · Settings↗ |
| WORKFORCE | Workers · Stations · Devices · Tasks | **TASKS** | Tasks (registry) · Workers (assign + lifecycle) · Receiving Workers (history) · Live Activity (execution feed) |
| WAREHOUSE | Warehouse Tree↗ · Receiving Containers · Temporary Storage · Batches · Receiving Workers · Categories↗ | **STATIONS** | Stations · Devices · Warehouse Tree↗ · Categories↗ |
| FULFILLMENT | Orders · Customer Bins · Shipments | **OPERATIONS** | Expected Arrivals↗ (new *link only* — page & perm pre-existing) · Receiving Containers · Temporary Storage · Batches · Orders · Customer Bins · Shipments · Exceptions · Corrections · Traceability · Data Control |
| MONITORING | Exceptions · Corrections*(missing) · Live Activity · Live Wallboard · Audit/Trace · Data Control | (monitoring items split per ownership above; big-format board stays in OPERATIONS) | — |
| SYSTEM | Settings↗ | — | — (Settings moves into CONTROL, the group it functionally is) |

Proposed rendered sidebar:

```
CONTROL      Overview · Operations · Settings↗
TASKS        Tasks · Workers · Receiving Workers · Live Activity
STATIONS     Stations · Devices · Warehouse Tree↗ · Categories↗
OPERATIONS   Expected Arrivals↗ · Receiving Containers · Temporary Storage ·
             Batches · Orders · Customer Bins · Shipments · Exceptions ·
             Corrections · Traceability · Data Control · Live Wallboard
```

Notes:
- `Sessions` has no top-level item in either structure (deep link from
  Operations/overview panels — the intended drill-down pattern; no change).
- The OPERATIONS group is the largest (11 items). The existing shell renders
  flat groups; if the owner wants strict "four groups with sub-sections"
  (Tasks / Operations / Stations / Control), the shell would need nested
  group support — a **component change**, therefore listed as an
  approval-gated option (Plan step 5b), not part of the minimal proposal.
- Nothing a worker sees changes: `NAV_ITEMS` (global shell) and
  `/terminal/*` are untouched.

---

## 4. Delivery 3 — Screen-by-screen classification

Domains: **A. Tasks · B. Operations · C. Stations · D. Control**
(H = hybrid; second domain in parentheses)

| Screen (route) | Class | Rationale |
|---|---|---|
| Tasks registry (`/admin/tasks`) | A | Task definitions/types + live execution numbers; mirrors backend `TASK_REGISTRY` (single source of truth) |
| Workers (`/admin/workers(/:id)`) | A (D) | Task assignment + execution tracking (A); employee lifecycle block/remove + creation (D) |
| Session drill-down (`/admin/sessions/:id`) | A | Task execution tracking: cartons, products, discrepancies, corrections, verification report |
| Receiving Workers report (`/admin/receiving-workers`) | A | Task execution *history* (who/what/when/result/duration/device) |
| Live Activity (`/admin/activity`) | A (B) | Execution event feed from the audit trail |
| Control Center overview (`/admin`) | B | Pipeline + live panels of the running operation |
| Operations (`/admin/operations`) | B | Operational workflows in sequence + active sessions |
| Exceptions (`/admin/exceptions`) | B | Operational exceptions + authorized resolution |
| Corrections ledger (`/admin/corrections`) | B | Operational correction history (append-only) |
| Traceability (`/admin/traceability`) | B | Operational chain across the workflow |
| Receiving Containers (`/admin/receiving-containers`) | B | Operational buffer unit (totes) |
| Temporary Storage (`/admin/temporary-storage`) | B | Operational buffer + capacity config + reports |
| Batches (`/admin/batches`) | B | Batch workflow board (flag OFF; untouched this phase) |
| Orders (`/admin/orders`) | B | Fulfillment workflow state (read-only) |
| Customer Bins (`/admin/customer-bins`) | B | Fulfillment workflow unit |
| Shipments (`/admin/shipments`) | B | Dispatch workflow state (read-only) |
| Stations (`/admin/stations`) | C | Station definitions, configuration, zone link, worker assignment |
| Devices (`/admin/devices`) | C | Worker/device associations (hardware binding) |
| Warehouse Tree↗ (`/warehouse/structure`) | C | Physical structure that station/zone config references |
| Categories↗ (`/categories`) | C (D) | Master data + category→sorting-zone configuration consumed by station workflows |
| Users (`/users`) | D | Employee accounts (identity) |
| Roles (`/roles`) | D | Employee roles & permissions |
| Audit log (`/audit`) | D | System-level audit (all events) |
| System (`/system`) | D | System configuration, API clients, health |
| Data Control (`/admin/data-control`) | D (B) | Centralized data governance: soft-void + force delete (admin-only) |
| Live Wallboard (`/admin/live`) | D (B) | Centralized monitoring display (SSE) |
| Expected Arrivals↗ (`/expected-arrivals`) | B (D) | Inbound input to the receiving workflow |
| Profile (`/profile`) | D | Identity |

Coverage check: **all 21 admin screens + 9 global admin screens classified;
no screen left unclassified; no screen claimed by two owners** (hybrids are
explicit, with a single primary home).

---

## 5. Delivery 4 — Duplication & accumulation report

| ID | Finding | Severity | Evidence | Recommendation |
|---|---|---|---|---|
| **AUD-01** | **Orphaned screen**: `/admin/corrections` route + page existed but **no nav item and no in-page link pointed at it** — the corrections ledger was unreachable from the UI (only per-session corrections were visible inside SessionDetail). | High (functional gap) | Route in `App.tsx`; `grep` across `src/` shows zero `to=`/`navigate(` references to `/admin/corrections` | **DONE in this command** — one nav entry added in `AdminShell.tsx` (MONITORING→now OPERATIONS in proposal; see §7). Route, page, permission gate all pre-existing. |
| **AUD-02** | **Overview vs Operations overlap**: both `/admin` (Control Center) and `/admin/operations` render the same `Pipeline` + `OperationsPanel` components from the same shared overview payload. Operations adds the active receiving/putaway session tables; the overview embeds "top rows" of each board by design. | Medium (redundant rendering, not a second system) | `ControlCenter.tsx` (default export) vs `Operations.tsx` (imports `Pipeline`, `OperationsPanel` from ControlCenter) | Keep both (different zoom levels); consolidation (e.g. overview shows pipeline summary + deep links only) is a **post-approval** candidate. No change now. |
| **AUD-03** | **Legacy API alias still wired**: the Workers page calls `GET/POST /v1/operations/worker-tasks` + `/worker-tasks/:id/cancel` (documented in the controller as *legacy aliases*), while the canonical surface is `/v1/operations/assignments` (same `AssignmentsService`, verified: `OperationsService.workerTasksList/Create/Cancel` are one-line delegations). The admin client also wraps `worker-tasks/:id/block|unblock` which **no UI code calls**. | Medium (tech debt pinned to a deprecated alias) | `admin/api.ts:492`, `Workers.tsx:301`; controller comments lines 430-517 of `operations.controller.ts` | Migrate the Workers page client calls to the canonical `assignments` endpoints (functionally identical), remove the two dead wrappers. **Approval-gated** (code change, not navigation). Backend aliases stay until every client (incl. mobile) has migrated; their removal is a separate, later approval. |
| **AUD-04** | **Dead client wrapper**: `adminApi.containers()` (`GET /v1/fulfillment/containers`) has zero consumers in the admin UI — the worker terminal uses its own `fulfillmentApi` from `terminal/fulfillment-api.ts`. | Low | `grep` across `src/` — only hit is the unrelated `fulfillmentApi` | Remove the wrapper (client-only) with AUD-03. No backend change. |
| **AUD-05** | **Two create-user surfaces**: `/users` (generic form, arbitrary role names) and Workers "Add worker" (role presets + `credentialMode: PASSWORD`) both `POST /v1/users` (server default `credentialMode='PASSWORD'` — verified in `users.service.ts:36`). Not data duplication (one table, one endpoint) but two forms an admin must know apart. | Low (by-design split audiences) | `pages/Users.tsx` vs `Workers.tsx` | Keep both; document the difference in both screens ("provisioning" vs "floor onboarding"). Unification = separate approval. |
| **AUD-06** | **Stale UI copy**: Tasks page footer reads *"Supervisor task-assignment screens are planned after the V1 Control Center is approved"* — COMMAND #3 already shipped assignment on the Workers page. | Low (misleading text) | `Tasks.tsx` last lines | One-line copy fix. **Approval-gated** (not navigation). |
| **AUD-07** | **Nav groups ≠ responsibilities**: *Receiving Workers* (workforce history) sits under WAREHOUSE; *Batches* (inbound workflow) under WAREHOUSE; *Categories* (master data) under WAREHOUSE; *Receiving Containers / Temporary Storage* (operational buffers) under WAREHOUSE. The WAREHOUSE group is a catch-all; the only true physical-structure item (Warehouse Tree) is an external link. | Medium (navigation clarity) | `AdminShell.tsx` NAV | Re-group per §3 proposal. **Approval-gated.** |
| **AUD-08** | **Three live "what happened" views**: overview ActivityPanel (10 events, 30s shared poll), `/admin/activity` (80 events, 15s, filterable feed), `/admin/live` (SSE wallboard). Different data paths and purposes (summary / feed / display) — not harmful duplication, but the naming doesn't say so. | Low | `Activity.tsx`, `LiveBoard.tsx`, `ControlCenter.tsx` | Keep all three; make intent explicit in labels/descriptions (e.g. "Live Activity — operational event feed" vs "Live Wallboard — display mode"). With the re-grouping (feed→TASKS, wallboard→OPERATIONS/CONTROL). |
| **AUD-09** | **No standalone Sessions board**: sessions are reachable only via drill-down from Operations/overview panels. Acceptable (deep-link pattern) but worth naming in the structure so nobody "adds" a sessions list screen later. | Info | `App.tsx` routes | Keep drill-down pattern; document as intended. |
| **AUD-10** | **Admin functionality split across two shells**: users/roles/audit/system/expected-arrivals/categories/warehouse live in the global shell; `/admin/*` carries redirect aliases. The rule "keep all Admin functionality under /admin" is currently satisfied via redirects only. | Medium (structural) | `App.tsx` alias block; `AdminShell.tsx` external links | **Recommend status quo** for now (global shell is shared with workers; moving routes would break deep links and role-visible nav). If the owner wants strict `/admin` containment, propose `/admin/control/{users,roles,audit,system}` with redirects — **separate approval**. |
| **AUD-11** | **Stale status doc**: `docs/WAREHOUSE-OS-STATUS.md` (2026-09-03) references `terminal/ReceivingTask.tsx`, which was deleted in the receiving rebuild. | Low (docs) | doc header | Refresh the doc when Phase 2 is approved (docs-only). |
| **AUD-12** | **Container vocabulary** (physical structure vs operational totes/bins vs batches) spans several screens. Verified: naming is consistent with the data model; the legacy `/admin/containers` alias already redirects to the right board. | Info (no action) | — | Keep; do not rename anything. |

**What was explicitly checked and is NOT duplication:**
- No duplicate routes (every route in `App.tsx` maps to exactly one component;
  `containers`, `arrivals`, `receiving`, `structure`, `users`, `roles`,
  `audit`, `system` under `/admin` are redirects, not screens).
- No duplicate components (all pages are unique files; `CorrectionDialog` is
  deliberately shared — single correction funnel).
- No parallel management systems (one stations controller, one devices
  controller, one assignments service, one corrections service, one
  task registry; admin API is a thin typed client over them).
- No unused *backend* endpoints surfaced by the admin: the only unused
  pieces are the two client wrappers (AUD-03/04) and the legacy aliases,
  which are intentionally kept for compatibility.

---

## 6. Delivery 5 — Dependency report (must-not-break)

**Routing & security (client)**
- `PermissionGate` + `SurfaceGate` in `App.tsx` — Order #3 admin/worker
  isolation; covered by `NavItems.surface.test.ts` (4 tests) and
  `Dashboard.surface.test.ts` (5 tests). Admin nav filtering is
  permission-driven (`hasPermission`), so any nav change must keep the
  per-item `permission` field.
- `AdminShell` polls `/v1/operations/overview` once per shell and serves it
  via Outlet context (`controlData.ts`) — overview + Operations +
  Control Center share one payload; do not introduce a second poll.

**Admin API surface (server, `/api/v1`)** — all permission-guarded
server-side (front-end hiding is UX only):
- `operations/*`: `overview`, `workers(/:id)`, `activity`, `tasks`,
  `receiving-containers`, `receiving-workers`, `customer-bins`,
  `containers/:code`, `sessions/:id`, `exceptions`, `corrections(+5 POST
  actions)`, `data-control/*` (search/void/voided/force-delete preview+action),
  `workers/:id/{block,unblock,remove}`, `assignments(+cancel/block/unblock)`,
  `worker-tasks*` (**legacy aliases — keep until clients migrate**),
  `receiving-reports(+review/close)`.
- `stations/*`, `devices/*`, `users`, `orders`, `fulfillment/articles &
  outbound-shipments & containers`, `batches/*` (flag-gated),
  `temporary-storage/admin/*`, `live/events` (SSE), `system/*`.

**Permissions (seeded, `backend/prisma/seed.ts`)** — keys must never be
renamed in this phase: `operations.view`, `operations.correct`,
`stations.view`, `stations.manage`, `users.view/manage`, `roles.view/manage`,
`audit.view`, `system.view/manage`, `warehouses.view` (+ granular
`zones/aisles/racks/levels/locations.*`), `inventory.view/manage`,
`expected_arrivals.view`, `api_clients.*`, `batch.view/create/execute/
accept/send/receive/void`, worker execute perms (`receiving.execute`,
`stowing.execute`, `picking.execute`, `packing.execute`, `shipping.execute`,
`receiving.resolve_discrepancy`). Role→permission matrix (SUPER_ADMIN,
WAREHOUSE_MANAGER, floor roles, France/Tunisia batch roles) is seeded
idempotently — do not edit.

**Shared business logic (cross-surface, out of scope but coupled)**
- `TASK_REGISTRY` (`backend/.../task-registry.ts`) — single source of task
  keys for worker terminal picker, admin Tasks board, and terminal
  `GET /terminal/tasks`. Admin `TASK_CATALOG` mirrors it for the
  assignment dropdown (backend validates; UI is convenience only).
- Worker terminal (`/terminal/*`) + Native Worker App (`mobile/`, Kotlin)
  consume the same workflows (receiving/putaway/sorting/packing/shipping/
  temp-storage/batches) and the device registry. **Any admin change to
  device binding, task keys, or station departments must be checked against
  these consumers.** (No such change is proposed here.)
- Batch: `batch.enabled` SystemSetting flag OFF by default; `batchActions()`
  pure matrix in `admin/batches.ts` is test-locked by `batches.test.ts`
  (9 tests) and mirrors the backend state machine. **Untouched by this
  command, per scope.**

**Data-integrity invariants (backend-enforced, surfaced by admin UI)**
- Corrections: append-only, mandatory reason, before/after snapshots,
  history never overwritten (`corrections.service.ts` + `CorrectionDialog`).
- Data Control: soft-void never deletes; force delete (arrival/carton only)
  requires reason + typed-back code; audit row kept forever.
- Workers: block = reversible LOCKED; remove = soft DISABLED (account +
  audit history kept).
- Stations→zone link is configuration (S11), validated + audited server-side.
- No DB access occurred during this audit; **no data read from, written to,
  or deleted in the database.**

---

## 7. Delivery 6 — Prioritized implementation plan

Legend: ✅ done this command · S1 safe (no structural change, minimal code)
· S2 structural (requires approval of §3 proposal) · A separate approval
needed by the mandatory rules.

| # | Step | Class | What moves | What remains | Why | Risk |
|---|---|---|---|---|---|---|
| 1 | Add missing **Corrections** nav entry (AUD-01) | ✅ done | one `NAV` entry in `AdminShell.tsx` (perm `operations.view`, MONITORING group) | route, page, API, permission gate — all pre-existing | Restores reachability of a live, already-built screen; zero new code beyond the entry | none — navigation only |
| 2 | Migrate Workers page client from legacy `worker-tasks` alias to canonical `assignments` endpoints (AUD-03) | S1 | 3 client call sites in `admin/api.ts` + `Workers.tsx` (list/create/cancel) | backend legacy aliases (kept for compatibility), all other Workers behavior, `users.manage` gating | Both endpoint sets hit the same `AssignmentsService` (verified delegation); stops pinning the admin UI to a deprecated alias; no payload shape change | very low — same service, same DTOs |
| 3 | Remove dead client wrappers: `workerTaskBlock`, `workerTaskUnblock`, `containers()` (AUD-03/04) | S1 | 3 unused methods in `admin/api.ts` | backend routes stay (aliases) | Removes accumulation without touching any live code path; typecheck + tests guard against hidden refs | very low |
| 4 | Fix stale Tasks-page footer copy (AUD-06) | S1 | one sentence | everything else on the page | Removes a false statement ("assignment screens planned") already superseded by COMMAND #3 | none — copy only |
| 5a | Re-group admin sidebar to **CONTROL / TASKS / STATIONS / OPERATIONS** per §3 (AUD-07, AUD-08) | S2 (approval) | group labels + item order in `NAV` data; Settings link moves into CONTROL group; Expected Arrivals added as an *external link only* (page/perm pre-existing) | all 21 routes, all permission gates, all legacy alias redirects, header strip, poll, drill-downs | Aligns navigation with the four responsibilities; nothing structural is created | low — pure nav data; covered by manual route walk + surface tests |
| 5b | *(option)* nested sub-sections in the admin sidebar for strict 4-group layout | A | `AdminShell` nav rendering (adds nesting) | everything from 5a | Only needed if the owner rejects the flat 6-group proposal | medium — component change |
| 6 | Decide `/admin` containment for users/roles/audit/system (AUD-10) | A | if approved: new `/admin/control/*` routes + redirects, global aliases kept one release | recommendation is **status quo** (global shell + redirects) | Owner decision on the "keep all Admin functionality under /admin" rule vs deep-link stability | medium-high if moved (deep links, role nav, tests) |
| 7 | Consolidate overview vs Operations overlap (AUD-02) | A | overview renders pipeline summary + deep links instead of full duplicate panels | Operations page stays the working view | Removes the one real rendering overlap | medium — touches two live pages |
| 8 | Document the two create-user surfaces (AUD-05); unification only if owner wants | A | copy on both screens | both forms, one endpoint | Kills confusion without behavior change | none (copy) / medium (merge) |
| 9 | Refresh `docs/WAREHOUSE-OS-STATUS.md` (AUD-11) | S1 (docs) | stale file content | everything else | Doc drift misleads future phases | none |
| 10 | Retire backend `worker-tasks` legacy aliases | A (later) | 3 backend routes | done only after step 2 ships **and** all clients (incl. mobile) confirmed off the alias | Backend change; must be a separate, approved step | low once consumers verified |
| — | Batch workflow, Worker App screens | out of scope | — | — | Explicitly excluded by COMMAND 01 | — |

**Order of execution once approved:** 2 → 3 → 4 → 9 (S1 batch, one PR),
then 5a (S2, one PR), then 7/8 (A items) only after owner review.
Step 1 is already complete.

---

## 8. Changes completed in this command

Exactly one file changed (verified by `git diff`):

```
frontend/src/admin/AdminShell.tsx
  +4 lines — adds the missing nav entry for the existing
     /admin/corrections route (AUD-01), permission operations.view,
     MONITORING group (position: after Exceptions).
```

What deliberately did NOT change: routes (`App.tsx`), all 22 admin page
components, `admin/api.ts`, `admin/batches.ts`, backend, Prisma schema,
seeds/permissions, worker terminal, mobile app, styles.

---

## 9. Validation — exact commands executed and results

Frontend (baseline → after change, both identical):

| Command | Result |
|---|---|
| `cd frontend && npm install --no-audit --no-fund --ignore-scripts` | OK, 285 packages. (`--ignore-scripts` was required: the `onnxruntime-node` postinstall downloads a binary from a host the sandbox egress proxy blocks with a TLS failure. Unit tests import only pure-TS modules, so this does not affect the suite. No other script was skipped that tests depend on.) |
| `cd frontend && npx vitest run` | **PASS — 15 test files, 142/142 tests** (includes `batches.test.ts` 9/9, `NavItems.surface.test.ts` 4/4, `Dashboard.surface.test.ts` 5/5) |
| `cd frontend && npm run typecheck` (`tsc --noEmit`) | **PASS, exit 0** |
| `cd frontend && npm run lint` | **0 errors**, 7 pre-existing warnings in `modules/receiving-terminal/*` (unused eslint-disable directives) — files untouched by this command |

Backend:

| Command | Result |
|---|---|
| `cd backend && npm install --no-audit --no-fund --ignore-scripts` | OK, 767 packages |
| `cd backend && npx prisma generate` | **FAILED in sandbox only** — Prisma engine download from `binaries.prisma.sh` is blocked by the sandbox egress proxy (verified: `curl` to that host fails with SSL handshake drop, while `registry.npmjs.org` returns 200). Not a code issue. |
| `cd backend && npx jest` | **5 suites pass / 42 tests pass, 0 test failures.** 21 suites fail to *compile* solely because the generated Prisma client types are absent (all errors are `Property '<model>' does not exist on type 'PrismaService'` / `import { Prisma } from '@prisma/client'`) — a direct consequence of the blocked engine download, present before any change in this command. No assertion-level failures anywhere. |

Confirmation of the mandatory checks:
- **Existing Admin routes remain functional:** no route definitions were
  touched; the only diff is a nav entry pointing to an existing route.
  Typecheck passes over the whole tree, including the edited shell.
- **Existing permissions preserved:** no permission key, gate, seed, or
  guard modified; the new nav item reuses `operations.view` (the gate the
  entire `/admin` tree already enforces server-side).
- **Tasks/Operations/Stations behavior retained:** their pages, APIs and
  services are untouched; 142 frontend tests (incl. the batch UI matrix)
  pass before and after.
- **No workflow broken, no data deleted/modified:** no backend file
  changed, no database connection made, no migration, no seed re-run.

---

## 10. Outstanding risks & unresolved questions

1. **Sidebar re-grouping (5a) is unapproved.** Until then the current
   group labels stay; the audit's classification (§4) should be treated as
   the planning model, not the live UI.
2. **AUD-10 needs an owner decision**: status quo (global shell + `/admin`
   redirects — recommended) vs strict `/admin` containment. This defines
   what "keep all Admin functionality under /admin" means operationally.
3. **Legacy alias retirement (step 10)** depends on a consumer check of the
   Native Worker App (`mobile/`) against `/v1/operations/worker-tasks*` —
   a grep of the Kotlin sources found no `worker-tasks` string (it uses
   `assignments`), but that check must be re-verified at implementation time.
4. **Backend test suite cannot fully run in this sandbox** (Prisma engine
   egress blocked). Before any backend-affecting step (only step 10), run
   the full jest suite in an environment with registry + Prisma egress.
5. **OPERATIONS group size** (11 items) — acceptable for a control room,
   but if the owner prefers strict 4-group nesting, 5b is the path.
6. **`/admin/live` (wallboard) placement** — proposed under OPERATIONS as
   the operational display; alternatively CONTROL (system monitoring).
   Owner preference.
7. Unresolved upstream decisions carried from `docs/OPEN-DECISIONS.md`
   (D-21..D-29) remain open and are unaffected by this audit.

---

## 11. Files & components inspected

**Frontend (all read in full or in targeted sections):**
`src/App.tsx` (complete route table + gates), `src/components/NavItems.ts` +
`NavItems.surface.test.ts`, `src/shell/GlobalShell.tsx`,
`src/admin/AdminShell.tsx` (nav registry, header, poll), `src/admin/api.ts`
(full API surface), `src/admin/controlData.ts`, `src/admin/batches.ts` +
`pages/Batches.tsx` + `batches.test.ts`, `src/admin/temp-storage.ts`,
`src/admin/pages/*` (all 22 files: Activity, Batches, ContainerDetail,
ControlCenter, CorrectionDialog, Corrections, CustomerBins, DataControl,
Devices, Exceptions, LiveBoard, Operations, Orders, OutboundShipments,
ReceivingContainers, ReceivingWorkers, SessionDetail, Stations, Tasks,
TemporaryStorage, Traceability, Workers, useAsync),
`src/pages/{Dashboard,Login,Profile,Users,Roles,Audit,System}.tsx` +
`Dashboard.surface.test.ts`, `src/modules/{warehouse,expected-arrivals,
categories}/*` (structure/tabs/masters), `src/terminal/*` (route-level
only — out of scope).

**Backend (read to map the API/permission contract):**
`operations.controller.ts` (full), `operations.service.ts` (alias
delegation + taskBoard sections), `stations.service.ts` (refs),
`task-registry.ts` (TASK_REGISTRY contract), `batches/*` (controller,
module, feature flag), `users.{controller,service}.ts` (creation defaults),
`system/live.controller.ts`, `temporary-storage.controller.ts` (admin
routes), `devices.controller.ts`, `prisma/seed.ts` (permission catalog +
role matrix), `common/guards/*` (application/permissions guards, refs).

**Docs:** `README.md`, `docs/OPEN-DECISIONS.md`,
`docs/WAREHOUSE-OS-STATUS.md` (stale — AUD-11), `docs/ADMIN-CONTROL-CENTER-*`
(command history), root `AYROVI_*` reports (context).

**Mobile:** directory-level + grep-level check only (consumer contract for
legacy aliases).

---

## 12. Recommended next command

**COMMAND 02 — Approval + safe alignment (S1 batch):**
1. Approve or amend the §3 proposed structure and the §4 classification.
2. On approval, execute plan steps **2, 3, 4, 9** as one PR (canonical
   `assignments` migration, dead-wrapper removal, copy fix, doc refresh)
   with the full frontend suite + backend suite (in a network-complete
   environment) green.
3. Then execute step **5a** (sidebar re-grouping) as a second PR.
4. Record owner decisions on AUD-02 (overlap consolidation), AUD-05
   (create-user unification), AUD-10 (`/admin` containment) as separate
   approvals — do not bundle them with navigation work.
5. Keep Worker App screen review and the new Receiving Batch integration
   out of scope until this Admin phase is signed off (per COMMAND 01 §8).
