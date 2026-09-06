# AYROVI — OPERATIONAL MODEL DISCOVERY REPORT
## Admin Web + Backend · Workers / Stations / Tasks / Workflows

- **Repository:** `issamweldlatifa-gif/Core-wh` — branch `arena/01a074c7-core-wh`, base commit `4b762cf` (merge of PR #3, on `master`).
- **Discovery date:** 2026-09-06.
- **Mode:** READ-ONLY DISCOVERY. No code, schema, or data was modified.
- **Evidence rule:** every claim is backed by a file path in the current checkout. Anything not provable from code is marked `UNKNOWN — EVIDENCE NOT FOUND`. Nothing is invented, nothing is fixed silently.

**Classification legend used throughout:**

| Tag | Meaning |
|---|---|
| `[FACT]` | Exists and works in the current implementation (code cited). |
| `[PARTIAL]` | Implemented in one place but incomplete / inconsistent (gap described). |
| `[MISSING]` | Not implemented anywhere (may exist as reserved enum/permission only). |
| `[UNKNOWN]` | Cannot be established from the current code/data. |
| `[CONFLICT]` | Two parts of the system disagree. |
| `[RECOMMENDATION]` | Future proposal — **NOT current behavior**. |

> **Relationship to prior audits:** an older audit exists (`AYROVI_WAREHOUSE_FULL_DISCOVERY_AUDIT.md`, dated 2026-09-02, commit `c50342e`). It is **out of date**: it states Sorting/Packing are `ready:false`, fulfillment does not exist, and there is no application-isolation. All of that changed (fulfillment flow, strict-isolation, devices, native app were added afterwards). This report supersedes it. `[CONFLICT — doc drift, see §26]`

---

# 1. Executive Summary

AYROVI Warehouse Core is a **modular-monolith Warehouse OS**:

- **Backend:** NestJS + Prisma + PostgreSQL, REST under `/api/v1` (global prefix + URI versioning — `backend/src/main.ts`), Swagger enabled. Three global guards on every route: `JwtAuthGuard` → `PermissionsGuard` → `ApplicationGuard` (`backend/src/app.module.ts`). `[FACT]`
- **Admin Web + Worker Terminal (web):** one React 18 + Vite SPA with three shells: generic `GlobalShell`, full-screen Worker Terminal (`/terminal`), and the Admin Control Center (`/admin`) — `frontend/src/App.tsx`. `[FACT]`
- **Native Worker App (Android/Kotlin/Compose):** real native app (NOT a WebView) in `mobile/` with a Honeywell **CT40 imager** integration, camera scanner, shared scan-decision core, and an offline-queue *model*. `[FACT]` — but its Receiving screen has **two high-severity behavioral breaks** vs the backend (§26 C-1, C-2).
- **Two application surfaces, strictly isolated at login/session level:** `ADMIN_WEB` vs `WORKER_NATIVE` (`ApplicationKind`, session-bound, device + station bound for native logins, roles re-checked on **every request**). `[FACT]` — but the guard is **opt-in per controller**, and the Receiving/Fulfillment controllers do not declare it (§26 C-3). `[CONFLICT]`
- **Operational model actually implemented:** Workers = `User` accounts with `OPERATIONAL`-class roles; Stations = physical work positions with department + capabilities; Tasks = a **hard-coded registry of 6** (`receiving`, `sorting`, `putaway`, `order-sorting`, `packing`, `shipping`) mapped to permissions; Workflow instances = `ReceivingSession`, `PutawaySession`, per-piece `ArticleUnit`, plus an admin-instruction layer `WorkerTaskAssignment`. There is **no generic TaskType/Workflow/TaskInstance engine** (§8). `[FACT]`
- **Receiving is the deepest workflow** (expected-arrival projection from CRM → session → carton scan → confirm → product/article reconciliation → discrepancies → completion), fully backend-authoritative, immutable expected data, idempotent carton scans via `operationId`. `[FACT]`
- **End-to-end flow exists beyond receiving:** article → receiving tote (RCN-) → sorting/storage to location → customer bin (BIN-) → packing → outbound shipment (OUT-) → dispatch, with full traceability and append-only history. `[FACT]`

**Bottom line readiness (detail in §31):** Worker App **PARTIAL** · Receiving **PARTIAL** (backend YES, native client broken) · CT40 **PARTIAL** · Phone **PARTIAL**.

---

# 2. Current Architecture

```
                    ┌────────────────────────────────────────────┐
  Arrival CRM ──────▶ integrations/arrivals/customer-cards       │  x-api-key service auth
  (external)        │ integrations/arrivals/shipments            │  idempotent on card id
                    │ integrations/orders                        │
                    └───────────────┬────────────────────────────┘
                                    ▼
┌───────────────────────────── BACKEND (NestJS, /api/v1) ───────────────────────────────┐
│ Global guards: JWT → Permissions (RBAC from DB per request) → Application (surface)   │
│ Modules: auth · users · roles · permissions · audit · system(+api-clients,+live SSE)  │
│          devices · warehouse (Warehouse→Zone→Aisle→Rack→Level→Location)               │
│          categories (Category Master + Zone mappings) · expected-arrivals · shipments │
│          receiving · putaway · fulfillment (containers/articles/packing/shipping)    │
│          orders · operations (terminal · stations · corrections · admin boards)      │
│ Prisma + PostgreSQL (30+ models, 21 migrations, self-repair bootstrap)                │
└───────┬───────────────────────┬──────────────────────────────┬───────────────────────┘
        ▼                       ▼                              ▼
  Admin Web (React)       Worker Terminal (React,         Native Android app
  /admin Control Center   /terminal full-screen,          mobile/ (Kotlin/Compose)
  + generic modules       same SPA, ?app=worker login)    WORKER_NATIVE login + device code
```

- Frontend dev proxy: Vite proxies `/api` → backend (nginx in prod does the same). `[FACT]`
- API versioning: URI, default `1` → `/api/v1/...`. `[FACT]` (`backend/src/main.ts:54-60`)
- Audit: every operational mutation writes `AuditLog` rows **inside the same transaction** (110+ action values in the enum). `[FACT]`
- Realtime: `system/live` SSE endpoint (`live.controller.ts`) + in-process `EventEmitter2` (`events.module.ts`) used by fulfillment (`emit('packed', …)`); no external bus. `[PARTIAL]`

**Surfaces (frontend route inventory relevant to this discovery):**

| Route | Shell | Purpose | Guard (frontend) |
|---|---|---|---|
| `/login` (`?app=worker`) | — | Login; `app` param selects ADMIN_WEB/WORKER_NATIVE | — |
| `/terminal` | WorkerShell | Task picker / assigned tasks / resume | session |
| `/terminal/receiving` | WorkerShell | Receiving workspace | `receiving.execute` |
| `/terminal/putaway` | WorkerShell | Carton stowing | `stowing.execute` |
| `/terminal/sorting` | WorkerShell | Article sorting + storage | `stowing.execute` |
| `/terminal/order-sorting` | WorkerShell | Customer-bin assignment | `picking.execute` |
| `/terminal/packing` | WorkerShell | Bin verification + pack | `packing.execute` |
| `/terminal/shipping` | WorkerShell | Dispatch confirmation | `shipping.execute` |
| `/admin/*` | AdminShell | Control Center, Workers, Stations, Devices, Exceptions, Corrections, Traceability, Orders, Outbound Shipments, Tasks, Activity, Live, Containers/Bins, Data Control | `operations.view` |
| `/expected-arrivals`, `/warehouse/*`, `/users`, `/roles`, `/audit`, `/system`, `/categories` | GlobalShell | Back-office modules | per-module permission |

Legacy routes `/warehouse/receiving` and `/receiving` **redirect** to `/terminal/receiving`. `[FACT]` (`App.tsx`)

---

# 3. Workers

**There is no separate "Worker" table.** A worker is a `User` whose roles have `applicationClass = OPERATIONAL`. `[FACT]` (`backend/prisma/schema.prisma` — `User`, `Role.applicationClass`)

### WORKER MODEL (actual implementation)

```
Worker (= User row)
│
├── id                      UUID            PK                      schema: users.id
├── name                    String                                  users.name
├── employeeCode            String  UNIQUE  login identifier        users.employee_code  ("Worker Key")
├── email                   String? UNIQUE                          users.email
├── username                —               NOT IMPLEMENTED (employeeCode is the username)  [MISSING by design]
├── passwordHash            String?         bcrypt                  users.password_hash
├── pinHash                 String?         bcrypt numeric PIN      users.pin_hash
├── credentialMode          Enum            PASSWORD | PIN | BOTH   users.credential_mode
├── status                  Enum            ACTIVE | LOCKED | DISABLED   (worker lifecycle)
├── roles                   UserRole[]      M:N join — roles NEVER stored on the session token as authority
├── permissions             (derived)       union of role permissions, re-read from DB per request
├── stationsAssigned        Station[]       via Station.assignedWorkerId (soft link, ≤1 enforced in service)
├── devices                 Device[]        via Device.assignedWorkerId (registry binding, CT40/phones)
├── workerTaskAssignments   WorkerTaskAssignment[]  admin-issued instructions
├── putawaySessions         PutawaySession[]
├── receiving sessions      via ReceivingSession.startedBy (string, not FK)
└── lastLoginAt / createdAt / updatedAt
```

- **Role ≠ permission** (explicitly): permissions live on `Permission` rows (`key` like `receiving.execute`), granted to roles via `RolePermission`; users get them only transitively through `UserRole`. There is **no per-user permission** anywhere. `[FACT]`
- Worker lifecycle (Admin → Workers page, `operations.service.ts`): `ACTIVE → LOCKED` (block, reversible, sessions revoked) · `LOCKED → ACTIVE` (unblock) · `ACTIVE/LOCKED → DISABLED` (remove — permanent from UI, open assignments cancelled, sessions revoked). `[FACT]`
- Presence: `workers()` computes `workedToday` from sessions + audit activity; `pendingTasks` from open assignments. `[FACT]`
- Seeded worker: `WORKER001` / "Ahmed Ben Salah" (INBOUND_WORKER, station ST-REC-01) — test seed only (`prisma/seed.ts`). Production users (per `docs/WORKFORCE-OPERATING-MODEL-P2-FINAL-REPORT.md`): `Isco` SUPER_ADMIN, `23282716` WAREHOUSE_ADMIN, `123456` PICKER, `1234567`/`WORKER001` INBOUND_WORKER, plus role-less ACTIVE `1234`/`12345` — `[UNKNOWN]` cannot be re-verified from this checkout (no DB dump in repo); flagged as documented production state.

**Worker status ("Worker Status" state machine) = `UserStatus`:** `ACTIVE` / `LOCKED` / `DISABLED`. There is **no separate shift/presence/break status**. `[MISSING]`

---

# 4. Worker Roles

Seeded system roles (`prisma/seed.ts`, all `isSystem=true`, protected from deletion; new custom roles can be created at runtime via `POST /roles` — data-driven):

| Role | applicationClass | Surface | Purpose | Key permissions (receiving-relevant) |
|---|---|---|---|---|
| `SUPER_ADMIN` | ADMIN | ADMIN_WEB | unrestricted | ALL (74 keys) |
| `WAREHOUSE_ADMIN` | ADMIN | ADMIN_WEB | warehouse administration | receiving view/**execute**/resolve, stowing exec, picking/packing/shipping exec, operations.view/**correct**, stations manage, users.manage |
| `WAREHOUSE_MANAGER` | ADMIN | ADMIN_WEB | day-to-day supervision | receiving view/execute/**resolve_discrepancy**, operations.view/correct, stations.**view** (no manage) |
| `INBOUND_WORKER` | OPERATIONAL | WORKER_NATIVE | floor: receiving + stowing | receiving.view/execute, stowing.view/execute, expected_arrivals.view, shipments.view, stations.view, structure/Phase-2 **view only** |
| `PICKER` | OPERATIONAL | WORKER_NATIVE | floor: order sorting | picking.view/execute (+ views) — **no receiving** |
| `PACKER` | OPERATIONAL | WORKER_NATIVE | floor: packing | packing.view/execute (+ views) |
| `VIEWER` | VIEWER | ADMIN_WEB (read-only) | read-only | receiving/stowing/picking/packing/shipping **view only** |

Per-role permission claims **as actually implemented** (not invented):

```
INBOUND_WORKER
 ├── Can log into the Worker app only (WORKER_NATIVE) .................... [FACT] auth.service application gate
 ├── Can view the Receiving task in the terminal ......................... [FACT] TASK_REGISTRY needs receiving.execute
 ├── Can start/resume a receiving session ................................. [FACT] POST /receiving/arrivals/:id/start
 ├── Can scan cartons (QR/barcode/manual) ................................. [FACT] POST /receiving/sessions/:id/scan-carton
 ├── Can confirm cartons received ......................................... [FACT] POST /receiving/sessions/:id/receive-carton
 ├── Can receive product units / scan articles into totes ................. [FACT] receive-product + fulfillment/scan-article
 ├── Can pause/resume a session ........................................... [FACT]
 ├── Can complete receiving WITH NO open discrepancies ..................... [FACT] (complete checks tally)
 ├── Can NOT complete receiving that has open discrepancies ................ [FACT] ForbiddenException unless receiving.resolve_discrepancy
 ├── Can NOT resolve discrepancies ........................................ [FACT] permission not in role
 ├── Can create/select receiving totes (RCN-) ............................. [FACT] POST /fulfillment/containers (receiving.execute)
 ├── Can execute Sorting/Putaway terminals ................................ [FACT] stowing.execute
 └── Can NOT see Admin Control Center / operations.* ...................... [FACT] not granted; session surface also blocks it

PICKER
 ├── Order Sorting terminal (article → customer bin) ...................... [FACT] picking.execute
 └── NO receiving, NO putaway/sorting-stowing ............................. [FACT]

PACKER
 └── Packing terminal (verify bin, pack, label) ........................... [FACT] packing.execute

SHIPPING WORKER role: NOT CURRENTLY IMPLEMENTED .......................... [MISSING]
  (shipping.execute is granted only to ADMIN-class roles + SUPER_ADMIN;
   no OPERATIONAL role can open the Shipping terminal today — §26 C-5)
SORTING WORKER as a distinct role: NOT CURRENTLY IMPLEMENTED ............. [MISSING]
  (category Sorting uses stowing.execute → INBOUND_WORKER covers it;
   the name mapping "SORTING WORKER = PICKER" is documentation-only)
```

- Role classification for surface isolation is **data-driven** (`Role.applicationClass`), with a legacy **name-based fallback** for unmigrated rows (`access/application-access.ts` — `classifyRole`). A role with class `UNKNOWN` opens no surface. `[FACT]`

---

# 5. Permissions

Catalog seeded in `prisma/seed.ts` (~74 keys; legacy Phase-0 keys migrated idempotently). Enforcement: `PermissionsGuard` is a **global APP_GUARD** — every route carrying `@RequirePermissions(...)` is checked against permissions **reloaded from the DB on each request** (`jwt.strategy.ts` rebuilds `AuthenticatedUser` per call); denials are audited (`UNAUTHORIZED_PERMISSION`). `[FACT]`

### Permission matrix (operational scope; "Backend enforced" = PermissionsGuard + service-level checks)

| Permission | Exists | Seeded role(s) | Backend enforced | Admin UI enforced | Notes |
|---|---|---|---|---|---|
| `receiving.view` | YES | ADM/WM/IBW/VIEWER | YES (`/receiving/arrivals`, `sessions/:id`) | Route gate on terminal (render) | listed twice in seed array `[LOW]` |
| `receiving.execute` | YES | WA/WM/IBW | YES (start/scan/receive/pause/resume/flag/complete) | Terminal route `PermissionGate` | also used for tote creation in fulfillment |
| `receiving.resolve_discrepancy` | YES | WA/WM/SUPER | YES — double: guard **and** service `actor.canResolveDiscrepancy` re-check | Exceptions page (admin) | worker actor structurally cannot |
| `expected_arrivals.view` | YES | many | YES | `/expected-arrivals` route | |
| `shipments.view` | YES | many | YES | (viewed inside arrivals/admin boards) | |
| `stowing.view` / `stowing.execute` | YES | WA/WM/IBW | YES (putaway + sorting endpoints) | Terminal gates | one key covers BOTH sorting & putaway tasks |
| `picking.view` / `picking.execute` | YES | WA/WM/PICKER | YES (order-sorting endpoints) | Terminal gate | |
| `packing.view` / `packing.execute` | YES | WA/WM/PACKER | YES | Terminal gate | |
| `shipping.view` / `shipping.execute` | YES | WA/WM/SUPER only | YES | Terminal gate exists, **no operational role holds it** | §26 C-5 |
| `operations.view` | YES | WA/WM/SUPER | YES (all admin boards) | `/admin` gate | deliberately NOT for floor workers |
| `operations.correct` | YES | WA/WM/SUPER | YES (corrections + data-control void) | Corrections/DataControl UIs | mandatory reason ≥ 8 chars |
| `stations.view` / `stations.manage` | YES | view: WA/WM/IBW; manage: WA/SUPER | YES | Stations page | also gates Devices registry |
| `users.view` / `users.manage` | YES | WA/SUPER (+view WM) | YES | Users page, Workers page, worker-tasks admin | worker-tasks admin needs users.manage |
| `inventory.view` / `inventory.manage` | YES | WA/WM (+view IBW/P/P) | key exists; used only for **Category Master** routes | Categories page (`inventory.view`) | no inventory-quantity system exists `[MISSING workflow]` |
| `audit.view` | YES | WM/SUPER/VIEWER | YES | Audit page | |
| `system.view/manage`, `api_clients.*` | YES | WA/SUPER | YES | System page | |
| Structure perms (`warehouses…locations.*` granular) | YES | per role tiers (D-34: manager no create) | YES | Warehouse module | |
| Phase-2 identity (`products.*`, `warehouse_orders.*`, `order_items.*`, `physical_items.*`) | YES | seeded | Controller perms **not all wired** — products/order-items/physical-items have **no controllers at all** | Orders admin board (`operations.view`) reads orders | `[PARTIAL]` §26 C-9 |

**UI visibility vs real authorization:** the frontend `PermissionGate` only hides routes; the backend guard is the enforcement (comments in `operations.controller.ts` §9/§41 confirm the intent). One structural exception is documented in §26 C-3 (application-surface guard missing on receiving/fulfillment ⇒ an ADMIN_WEB session holding `receiving.execute` — e.g. WAREHOUSE_ADMIN/MANAGER — can execute worker operations through the API; this is a **surface-isolation gap**, not a permission bypass, because those roles legitimately hold the permission).

---

# 6. Stations

Model `Station` (`schema.prisma`, registry service `operations/stations.service.ts`): `[FACT]`

```
STATION
├── id                UUID
├── code              UNIQUE, normalised A-Z0-9_- (2-30)     e.g. ST-REC-01
├── name
├── department        enum: RECEIVING | SORTING | PUTAWAY | PACKING | INVENTORY | DISPATCH
├── status            enum: ACTIVE | INACTIVE | MAINTENANCE
├── assignedWorkerId  → User (soft link; SetNull; ≤1 station per worker enforced in service)
├── deviceId          String?  ⚠ free-text, NOT an FK to the Device registry   [CONFLICT C-8]
├── capabilities      enum[]: CAMERA | BARCODE_SCANNER | QR_SCANNER | OCR | PRINTER | SCALE
├── warehouseId       → Warehouse?
└── createdAt/updatedAt
```

- **Capabilities never branch the workflow** (`stations.service.ts` §11): they only tell the terminal which input affordances to render (e.g. the OCR toggle in the receiving scanner is enabled only if the station advertises `OCR`; `stationHas()` returns `true` when the worker has **no** station so an unregistered device never blocks work). `[FACT]`
- Assignment rules: assigning a worker to a station **clears any other station** holding that worker (`updateMany … assignedWorkerId: null`) — a worker can hold **at most one** station. Worker must be ACTIVE. `[FACT]`
- Station is resolved **server-side** from the worker's assignment when sessions start (`resolveStationId` in receiving/putaway services) — the client can never claim a station. `[FACT]`
- Station status changes do **not** cascade to sessions (historical sessions keep `stationId`; `SetNull` only on delete). `[FACT]`
- **Seeded stations** (`prisma/seed.ts`, TEST data): `ST-REC-01` Receiving Dock 1 (CAMERA, BARCODE_SCANNER, QR_SCANNER, OCR, SCALE; warehouse TUN-MAIN; assigned worker WORKER001), `ST-REC-02` Receiving Dock 2, `ST-SRT-01` Sorting Bench 1, `ST-PCK-01` Packing Bench 1, `ST-SHP-01` Shipping Dock 1. **No seeded PUTAWAY or INVENTORY station** — putaway workers run with `station = null` in seed state. `[PARTIAL]`
- Capabilities come **only from configuration** (admin checkboxes on `/admin/stations`); nothing is inferred from names. `[FACT]`

---

# 7. Task Types

The single source of operational task types is the **hard-coded TASK_REGISTRY** (`backend/src/modules/operations/terminal.service.ts`). There is no `TaskType` database table. `[FACT]`

| # | Task key | Label | Department | Permission gate | Web route | Native tab | Status |
|---|---|---|---|---|---|---|---|
| 1 | `receiving` | Receiving | RECEIVING | `receiving.execute` | `/terminal/receiving` | RCV | `[FACT]` ready |
| 2 | `sorting` | Sorting (category storage) | SORTING | `stowing.execute` | `/terminal/sorting` | SORT | `[FACT]` ready |
| 3 | `putaway` | Putaway (carton stowing) | PUTAWAY | `stowing.execute` | `/terminal/putaway` | — (folded into SORT UX on native) | `[FACT]` ready |
| 4 | `order-sorting` | Order Sorting (customer bins) | SORTING | `picking.execute` | `/terminal/order-sorting` | BIN | `[FACT]` ready |
| 5 | `packing` | Packing | PACKING | `packing.execute` | `/terminal/packing` | PACK | `[FACT]` ready |
| 6 | `shipping` | Shipping | DISPATCH | `shipping.execute` | `/terminal/shipping` | SHIP | `[FACT]` code-ready, **no OPERATIONAL role holds the permission** `[CONFLICT C-5]` |

Native-only extra tabs (not in TASK_REGISTRY): `RECEIVING_CONTAINER` (tote filling — mapped from task key `receiving`?? no: `StationKey.fromKey` maps `"receiving-container"` which **no registry task emits**, so the TOTE tab never renders unless a task key `receiving-container` is added) `[CONFLICT C-10]`, and `ARCHIVE_TRACE` (trace screen; likewise no registry key emits `archive-trace` — the tab is unreachable in practice). `[PARTIAL]`

Additionally: **task-per-task detail required by §7 of the brief** — for every task: ID = registry `key`; required role = any role granting the permission; allowed station = **none enforced** (department matching between station and task is **not checked** anywhere — a receiving worker assigned to a DISPATCH station can still receive; station is recorded, not validated) `[FACT — no station/task compatibility rule exists]`; required device = none; scanner requirement = all tasks scan but all accept **manual entry** as fallback `[FACT]`; input/output/workflow per task:

| Task | Input (scan/manual) | System decision | Output (state writes) | Completion |
|---|---|---|---|---|
| receiving | arrival pick; carton code; SKU + qty; tote code | carton matched vs shipment; SKU vs expected line | `ReceivingSession`, `ReceivingCarton`, carton→RECEIVED, `ReceivingProduct`, `ReceivingDiscrepancy`, (optional) `ArticleUnit` | `complete` → COMPLETED[_WITH_DISCREPANCY] + arrival→RECEIVED[_WITH_DISCREPANCY] |
| putaway | carton code; location code | carton must be RECEIVED; location ACTIVE | `PutawaySession`, append-only `CartonPlacement`, carton→STORED + currentLocationId | `complete` on session |
| sorting | article code (ART-) | Category→`CategoryZoneMapping`→zone (+ free locations) | article→STORED + currentLocationId | per-article STORED (no session aggregate) |
| order-sorting | article code; bin code | article→open order needing SKU; bin must belong to that order | article→IN_CUSTOMER_BIN + orderId; bin→READY_FOR_PACKING when complete | per-article; bin readiness flag |
| packing | bin code | bin completeness vs order items | `OutboundShipment` READY_TO_SHIP; articles→PACKED; bin→PACKED | per-bin PACK |
| shipping | OUT- label | shipment must not be SHIPPED | shipment→SHIPPED; articles→SHIPPED; bin→CLOSED | per-shipment SHIP |

Not implemented anywhere (reserved permissions/enums only): **Transfer, Cycle Count / inventory counting, Inspection/QC task, Returns, Loading.** `[MISSING]` — `LocationType.QC/RETURNS/STAGING` and `PhysicalItemStatus.*` are schema reservations only; `AuditAction.ITEM_PICKED` etc. are placeholders.

---

# 8. Task Type vs Workflow vs Task Instance

The current system does **NOT** have a generic three-layer task model. `[FACT]` The distinction exists only implicitly:

| Concept | Where it lives today | Implementation form |
|---|---|---|
| TASK TYPE | `TASK_REGISTRY` (code) + permission keys (DB) | hard-coded list of 6; adding a terminal = "add a value to `StationDepartment` + a registry entry + a handler" (comment in terminal.service.ts §44) |
| WORKFLOW | Service classes: `ReceivingService`, `PutawayService`, `FulfillmentService` | each workflow is bespoke code; steps are NOT data |
| TASK INSTANCE | `ReceivingSession` (RCV-), `PutawaySession` (PUT-), per-piece `ArticleUnit` (ART-), per-action rows (`ReceivingCarton`, `CartonPlacement`) | concrete operational records |
| (separate layer) Admin instruction | `WorkerTaskAssignment` | OPEN/DONE/CANCELLED — a checklist item, **not** linked to the workflow engines (only `relatedType`/`relatedCode` strings) |

Consequences to record (not fix): a "Receiving task" for a worker is either (a) the terminal task type (always available while the permission is held), or (b) an admin `WorkerTaskAssignment` pointing at an arrival code (displayed on the terminal home, completed with a **note only** — completing it does NOT start/complete a `ReceivingSession`). These two layers are **not connected**. `[CONFLICT C-11 — semantic duplication of "task"]`

---

# 9. Task Assignment Logic

Actual behavior, question by question (§9 of the brief):

| Question | Actual behavior | Class |
|---|---|---|
| Who creates a task? | No task creation for workflows — tasks are always-available registry entries gated by permission. Admin creates `WorkerTaskAssignment` instructions (`POST /operations/worker-tasks`, `users.manage`). | `[FACT]` |
| Who assigns a task? | Admin assigns instructions; **stations** are assigned to workers by admin (`POST /stations/:id/assign`). Workflow work itself is self-started by the worker. | `[FACT]` |
| Automatic assignment? | **No** auto-assignment engine. Routing heuristics only: resume open session > single ready task > picker (`terminal.service.context`). | `[FACT]` (absence) |
| Can workers claim tasks? | Partially: receiving = worker picks any listed arrival and starts a session (one active session per arrival enforced — second starter gets **the same session returned**, not an error); putaway = shared FIFO queue of RECEIVED cartons (`/putaway/queue`), **no claim/lock** — two workers can attempt the same carton; `place()` is idempotent-safe but work can be duplicated. | `[PARTIAL]` |
| Admin manual assignment? | YES — `WorkerTaskAssignment` (instruction layer only). | `[FACT]` |
| Multiple workers on one task? | Receiving session: **yes technically** — `requireActiveSession` checks session status only, never the actor; any `receiving.execute` user can scan into a session another worker started (by design for recovery, but there is no multi-worker awareness/roster). | `[FACT]` (no restriction) |
| One worker, multiple active tasks? | YES — a receiving AND a putaway session can be open simultaneously (terminal picks the most recent as `resume`). No concurrency cap. | `[FACT]` |
| Station assignment required? | NO — `resolveStationId` returns null when unassigned; everything still works; terminal shows "NO STATION". | `[FACT]` |
| Role required? | YES — permission required for every workflow endpoint; role-less accounts can log in to no surface. | `[FACT]` |
| Device type considered? | NO for authorization; device matters only for (a) WORKER_NATIVE login device-code binding (registry `Device`), (b) UI scan-method choice. Backend never branches workflow on device. | `[FACT]` |
| Worker changes station? | Live worker sessions bound to the old station are **revoked on next request** (`jwt.strategy` station re-check → 401 "station assignment changed — sign in again"). Receiving/Putaway sessions keep the historical `stationId`. | `[FACT]` |
| Worker goes offline? | Web: OFFLINE badge only; every action fails (no offline web queue). Native: `OfflineQueue` pure model exists (dedupe by operationId, max 500) but is **in-memory only, not persisted, no sync worker wired** → effectively no offline execution. | `[PARTIAL]` |

Assignment chain actually enforced:

```
Worker (User)
   ↓ roles → permissions (DB, per-request)
   ↓ [optional] Station.assignedWorkerId (≤1) — captured at login & session start
   ↓ permission filter of TASK_REGISTRY → permitted tasks
   ↓ worker self-starts session (receiving) / pulls shared queue (putaway/sorting/...)
   ↓ service-level workflow rules (status gates, zone validation, completeness)
```

---

# 10. Receiving — Current Model (THE core discovery)

Nothing below is proposed — all of it is traced in `backend/src/modules/receiving/receiving.service.ts`, `fulfillment.service.ts`, and the terminals.

**A. What is Receiving?** Physically confirming that the cartons/units EXPECTED (Customer Arrival Card + Shipment Card pushed by the Arrival CRM) actually arrived. Expected data is **IMMUTABLE** during receiving; the system writes separate observation rows and never overwrites expected quantities. `[FACT]`

**B. What starts Receiving?** A worker (any `receiving.execute`) selecting an Expected Arrival in status `EXPECTED` (or resuming `RECEIVING`/`PAUSED`) → `POST /receiving/arrivals/:idOrCode/start {deviceType?, deviceName?, scanSource?}`. Admin can additionally attach a `WorkerTaskAssignment` (advisory text on the terminal home — does not start anything). `[FACT]`

**C/D. What entity is received?** The **Expected Arrival** is the reconciliation root. Physically scanned entities are: **cartons** (`WarehouseCarton`, CTN- identity from the CRM Shipment Card) and **product units/SKUs** (`ReceivingProduct` lines, optionally materialised as per-piece `ArticleUnit`s). The arrival is not "a shipment": the session pins ONE **primary shipment** (`arrival.shipments[0]`) for wrong-shipment validation, while expected quantities come from arrival items. `[FACT]`

**E. What does the worker scan?**
1. Carton codes: `externalCartonId` / `qrCodeValue` / `barcodeValue` / `cartonReference` (QR, 1D barcode, or manual; camera / hardware wedge / typed). `[FACT]`
2. Product SKU/reference (+ optional quantity, default 1). `[FACT]`
3. (Optional, when a tote is active) the same SKU scan also creates an `ArticleUnit` inside a `RCN-` tote. `[FACT]`

**F. After scanning Arrival (start):** session `RCV-xxxxxx` created; expected product lines **seeded & aggregated by SKU** (multiple card lines with the same SKU merge; lines with no SKU/reference become `NEEDS_REVIEW` rows); arrival → `RECEIVING`; station resolved server-side; audit `RECEIVING_STARTED`. `[FACT]`

**G. After scanning a carton:** lookup across **ALL shipments**; outcomes (returned as `flash` on the session payload):
- not found → `ReceivingCarton status=UNKNOWN` + open `UNKNOWN_CARTON` discrepancy (piece of paper still on the dock, recorded, NOT attached);
- belongs to another shipment (vs session's primary shipment) → `WRONG_SHIPMENT` row + discrepancy;
- already RECEIVED (in session or carton status) → `DUPLICATE_CARTON` flash, **no write**;
- identified → `CARTON_IDENTIFIED` flash. The **web terminal then auto-calls `receive-carton`** (§24 comment: no button press) which writes `ReceivingCarton status=RECEIVED`, sets `warehouseCarton.status=RECEIVED`, `receivedAt/By`, audit `CARTON_RECEIVED`. Idempotency: unique `operationId` on `receiving_cartons` (retries return the same session state). `[FACT]`

**H. After scanning a product/SKU:**
- Known line: `receivedQuantity += qty`, `difference` recomputed; status `EXPECTED → PARTIALLY_RECEIVED → RECEIVED`, or `OVERAGE` when exceeding expected (transition into OVERAGE opens an `OVERAGE` discrepancy). `[FACT]`
- Unknown SKU: new line `status=UNEXPECTED` + open `UNEXPECTED_PRODUCT` discrepancy (never silently added to expected). `[FACT]`
- With an active tote: `fulfillment/receiving/sessions/:id/scan-article` does the same reconciliation **+1** and additionally creates a traceable `ArticleUnit` (`ART-` code, `status=IN_CONTAINER`, provenance: session + expected line + optional source carton + container). Unexpected article → discrepancy but the piece IS recorded (physical reality). `[FACT]`

**I. Quantity handling:** worker enters/scans SKU with qty (min 1, floor); expected never modified; `difference = received - expected` persisted per line; tally computed live (expected/received cartons, products, units, shorts, overages, unexpected, missing cartons). `[FACT]`

**J. Discrepancies:** typed (`SHORTAGE, OVERAGE, UNKNOWN_CARTON, WRONG_SHIPMENT, DUPLICATE_SCAN, UNEXPECTED_PRODUCT, MISSING_PRODUCT, MISSING_CARTON, IDENTIFICATION_ERROR, OTHER`), status `OPEN → RESOLVED | REJECTED`. Workers can raise (`flag` endpoint — API only, no web button `[PARTIAL]`). Resolution: supervisor via `/receiving/discrepancies/:id/resolve` (`receiving.resolve_discrepancy`, checked twice: guard + actor flag) or admin Exception Center (`operations.correct` + mandatory reason + before/after snapshot `OperationCorrection`). `[FACT]`

**K. Damaged/missing/extra:** missing = SHORT at completion (line flipped `SHORT`, session closes WITH_DISCREPANCY); missing carton = `missingCartons = expectedCartons - receivedCartons` tally; extra = OVERAGE/UNEXPECTED lines + discrepancies. **There is no dedicated DAMAGED state or damage-reason capture.** `[MISSING]`

**L. Confirmation:** "confirm" = the `receive-carton` commit (cartons) and each accepted product scan (units). No separate signature step. `[FACT]`

**M. Completion:** `POST /sessions/:id/complete` → `reconcile()`; if `openDiscrepancies>0 || shortUnits>0 || overageUnits>0 || unexpectedProducts>0 || missingCartons>0` ⇒ **only a supervisor** (`receiving.resolve_discrepancy` or `operations.correct`) may close ⇒ session `COMPLETED_WITH_DISCREPANCY`, arrival `RECEIVED_WITH_DISCREPANCY`, remaining EXPECTED/PARTIAL lines flipped to `SHORT`; else session `COMPLETED`, arrival `RECEIVED`. Audited. `[FACT]`

**N. Backend states:** see §19 state machines (arrival, session, carton, product line, discrepancy, scan-event status).

**CURRENT RECEIVING FLOW (as implemented — not proposed):**

```
CRM Customer Arrival Card (x-api-key, idempotent)
        ↓
ExpectedArrival EXPECTED (WAR-…) + items  ·  Shipment Card → WarehouseShipment + WarehouseCartons EXPECTED (CTN-…)
        ↓
WORKER opens /terminal/receiving (or native RCV tab) → GET /receiving/arrivals (picker)
        ↓
START session (deviceType/deviceName/scanSource recorded; station resolved server-side)
        ↓  seeds ReceivingProduct lines (SKU-aggregated; category + CONFIRMED/NEEDS_REVIEW snapshot)
SCAN CARTON (QR/barcode/manual · camera/wedge/keyboard · operationId)
        ↓  validation: unknown → UNKNOWN row+discrepancy · wrong shipment → rejected+discrepancy · duplicate → flash only
CONFIRM receive-carton → carton RECEIVED (auto on web after IDENTIFY)
        ↓
SCAN PRODUCT (sku × qty)  — or —  SCAN ARTICLE INTO TOTE (RCN-) → ArticleUnit IN_CONTAINER
        ↓  reconciliation per line (EXPECTED→PARTIAL→RECEIVED / OVERAGE / UNEXPECTED + discrepancy)
[PAUSE / RESUME] (arrival mirrors RECEIVING/PAUSED)
        ↓
COMPLETE → tally · zero discrepancies? → session COMPLETED + arrival RECEIVED
                     └ discrepancies? → supervisor only → COMPLETED_WITH_DISCREPANCY + arrival RECEIVED_WITH_DISCREPANCY, shorts flagged
```

**MISSING / UNKNOWN in Receiving (reported, not invented):** mandatory-scan rules (carton scan is **not** enforced before product scans — `[FACT: no rule]`); arrival-scan step (the worker picks from a list; there is **no barcode scan of the WAR- code** to start a session — start accepts an id-or-code string typed/pasted) `[PARTIAL]`; multi-shipment sessions (only shipment[0] is validated — cartons of the arrival's *second* shipment would be rejected as WRONG_SHIPMENT) `[CONFLICT C-12 — HIGH]`; offline receiving `[MISSING]`; damaged-goods capture `[MISSING]`; receiving at station/department validation `[MISSING]`.

---

# 11. Arrival Model

`ExpectedArrival` (`schema.prisma` — table `expected_arrivals`): `[FACT]`

| Field | Type | Notes |
|---|---|---|
| id / **code** | uuid / unique `WAR-XXXXXXXX` | server-generated human/barcode display code |
| customerArrivalCardId | unique | idempotency anchor (CRM card id) |
| arrivalId / arrivalReference | nullable | external CRM arrival ids |
| customerId / customerName | string | **projection only — no local customer table** |
| storeId / storeName | nullable | |
| status | `EXPECTED · RECEIVING · PAUSED · RECEIVED · RECEIVED_WITH_DISCREPANCY · VOIDED` | lifecycle in §19 |
| source | `ARRIVAL_CRM` (only value) | |
| productCount / totalUnits | int | denormalized card totals |
| apiClientId / idempotencyKey / receivedViaApi(At) | | provenance |

Items: `ExpectedArrivalItem` — `productId?`(external ref), `sku?`, `reference?`, `productName?`, `quantity (>=1 DB CHECK)`, `variant/color/size`, **`category`/`subcategory` (UPPERCASE from CRM, NULL displayed as UNKNOWN, never guessed)**, `classificationSource` (AI|MANUAL), **`categoryStatus` = CONFIRMED|NEEDS_REVIEW** (validated against `CategoryMaster` at intake; UNCLASSIFIED/unknown/inactive ⇒ NEEDS_REVIEW), `storeId/storeName`.

**Actual relationships:**

```
ExpectedArrival (WAR-) 1─n ExpectedArrivalItem (expected SKU lines)
        │ 1
        ├─n WarehouseShipment (WSHP-) 1─n WarehouseCarton (CTN-)
        │              (arrivalId nullable; a shipment can exist unlinked)
        ├─n ReceivingSession (RCV-) 1─n ReceivingCarton / ReceivingProduct / ReceivingDiscrepancy
        │                          └─n ArticleUnit (ART-)
        └─ arrival status mirrored on receiving session transitions (RECEIVING/PAUSED/RECEIVED*)
```

No `Arrival → Receiving Task` FK exists: the link is `ReceivingSession.arrivalId` (+ optional `WorkerTaskAssignment.relatedCode` string). `[FACT]`

---

# 12. Shipment Model

**Two distinct shipment concepts exist** (must not be merged): `[FACT]`

1. **Inbound `WarehouseShipment`** (CRM Shipment Card → warehouse): fields — `code WSHP-`, `externalShipmentId` (idempotent), link to ExpectedArrival (local id + external id), sourceType (`MANUAL/CARRIER_API/IMPORT/OTHER`), carrier block (name/code/service/account ref), tracking block (`trackingNumber/Url/masterTrackingNumber/carrierTrackingReference`, **`trackingStatus` enum CREATED·READY_TO_SHIP·SHIPPED·IN_TRANSIT·OUT_FOR_DELIVERY·DELIVERED·CANCELLED·UNKNOWN — informational only, never updated by the warehouse**), sender & destination blocks, dates (shippedAt, estimatedArrivalAt, actualArrivalAt), summary counts (totalCartons/Products/Units), weight. Tracking status is a CRM projection; no carrier adapter exists inbound. `[FACT]`
2. **Outbound `OutboundShipment`** (created at Packing): `code OUT-XXXXXX` (internal label/QR), `orderId` (required), `containerId` (bin), `status READY_TO_SHIP → SHIPPED`, `carrier`/`trackingNumber` **NULL until a real adapter is configured** (`NullCarrierAdapter` — nothing invented), `packedBy/At`, `shippedBy/At`. `[FACT]`

---

# 13. Carton / Package Model

`WarehouseCarton` (table `warehouse_cartons`): identity `externalCartonId` UNIQUE (CTN- from CRM) + `cartonReference?`, **`qrCodeValue?` / `barcodeValue?`** (scannable values), `cartonNumber/totalCartons`; `status` EXPECTED·RECEIVED·STORED·FLAGGED·WRONG_SHIPMENT·VOIDED; dims/weight; `receivedAt/By`; `currentLocationId` (NULL until putaway) + `storedAt`; relations → shipment, `ReceivingCarton` events, `CartonPlacement` history, `ArticleUnit`s scanned out of it.

- "Package" does not exist as a separate entity (carton covers it; outbound "packages" are OutboundShipments). `[MISSING by design]`
- `FLAGGED` on `WarehouseCarton`: **no code path sets it** (the `flag` endpoint writes a discrepancy, not the carton status) — reserved. `[PARTIAL]`
- `WRONG_SHIPMENT` on `WarehouseCarton`: also never written (wrong-shipment is recorded on the `ReceivingCarton` event row, string status). Reserved enum value. `[PARTIAL]`

Actual hierarchy (replaces the example in the brief):

```
CRM Customer Arrival Card ──▶ ExpectedArrival (WAR-) ──▶ ExpectedArrivalItem (SKU lines, category)
                                      │
CRM Shipment Card ─────────▶ WarehouseShipment (WSHP-) ──▶ WarehouseCarton (CTN- … n cartons)
                                      │                          │
ReceivingSession (RCV-) ─▶ ReceivingCarton (scan events) ──▶ carton RECEIVED
        │
        ├─▶ ReceivingProduct (expected-vs-received per SKU)
        └─▶ ArticleUnit (ART-)  ──▶ OperationalContainer RCN- (receiving tote) ──▶ Location (STORED)
                                     └─▶ OperationalContainer BIN- (customer bin) ──▶ OutboundShipment (OUT-) ──▶ SHIPPED
```

---

# 14. Product Model

Three coexisting product/piece concepts — documented **as implemented**, with their (loose) coupling:

1. **`Product`** (Phase-2 identity): unique per `(store, externalProductCode)`, name, `productType` free text, attributes JSON, ACTIVE/INACTIVE. **No controller/service exposes CRUD today** (permissions seeded only); used by `WarehouseOrder/OrderItem`. `[PARTIAL — C-9]`
2. **`ExpectedArrivalItem.sku`** (CRM line) — the SKU string workers actually scan at receiving; `ReceivingProduct.sku` mirrors it; `ArticleUnit.sku` copies it forward.
3. **`ArticleUnit`** (operational per-piece): born at the receiving article scan; code `ART-XXXXXXXX`; carries category snapshot + categoryStatus; provenance (arrival item, session, source carton); current container/location/order/outbound links; status machine RECEIVED→IN_CONTAINER→STORED→IN_CUSTOMER_BIN→PACKED→SHIPPED|VOIDED. `[FACT]`
4. **`PhysicalItem`** (Phase-2 per-piece identity, `PI-` codes, status lifecycle RESERVED): **no API writes it; no workflow consumes it.** `[MISSING — reserved]`

**Coupling risk (report only):** Packing completeness matches `OrderItem.product.externalProductCode` against `ArticleUnit.sku` (fulfillment.service `packingScanContainer`/`checkOrderCompleteness`). Nothing enforces that CRM SKUs and order product codes share a namespace. `[UNKNOWN — cross-system code consistency is assumed, not validated]`

SKU / UNIT / CARTON / SHIPMENT / ARRIVAL are therefore **separate entities** as mapped in §13; "UNIT" exists only as ArticleUnit or counted quantities (`receivedQuantity`), not as a standalone table. `[FACT]`

---

# 15. Scanner Architecture

### Web (Admin Web / Worker Terminal — `frontend/src/modules/receiving-terminal/`)
- **Device detection** (see §16) → **dual-scanner policy** (`scan-method.ts`): DESKTOP ⇒ Hardware primary (never opens the webcam implicitly); SMARTPHONE/TABLET ⇒ Software primary; selection persisted (`localStorage ayrovi.scanMethod`), tab switch inside the scanner header. `[FACT]`
- **Software scanner** (`ContinuousScanner.tsx`): single decode loop — barcode/QR **first** (ZXing `MultiFormatReader` with formats CODE_128/39/93, CODABAR, EAN_13/8, UPC_A/E, ITF, QR_CODE, DATA_MATRIX + native `BarcodeDetector` fast path); OCR fallback **only after barcode failures**, gated by image-quality checks, ROI text-line targeting, profile preprocessing, field extraction/normalisation, **corpus validation** (EXACT→auto-confirm / CANDIDATE→worker confirm / LOW→retry), confidence scoring, multi-frame consensus, duplicate guard (one physical scan = one event). OCR engines: Tesseract.js default; PP-OCR level-2 opt-in (`?ocr=ppocr`). Telemetry recorded client-side (no images stored). `[FACT]`
- **Hardware scanner** (`HardwareScannerPanel.tsx` + `hardware-wedge.ts`): keyboard-wedge capture with keystroke-timing classification (`classifyKeyboardEntry` — avg < 40 ms/char ⇒ `EXTERNAL_SCANNER`, else `MANUAL`). `[FACT]`
- **Manual input**: always-available fallback inputs in every terminal screen. `[FACT]`
- **Scan provenance contract** (backend): `ScanType` QR|BARCODE|MANUAL and `ScanSource` CAMERA|EXTERNAL_SCANNER|MANUAL stored on `ReceivingCarton`/`CartonPlacement`; putaway records **both** carton and location capture sources. `[FACT]`
- **Idempotency / duplicates / invalids:** carton scans deduped server-side via unique `operationId`; duplicate cartons → flash only; unknown carton → recorded UNKNOWN + discrepancy; product scans have **no server-side operationId idempotency** (`[MISSING — C-4]`); frontend duplicate-guard windows prevent double submit while busy.
- **Coupling:** the scanner stack physically lives under `modules/receiving-terminal/` but is **reused by every terminal task** (Sorting/OrderSorting/Packing/Shipping import `ContinuousScanner`; Putaway uses ContinuousScanner + manual; Receiving uses the dual-scanner host). Business logic is NOT in the scanner: every accepted value funnels into one submit pipeline per screen; **the backend verdict is the only success path**. `[FACT]`

### Native (Android — `mobile/`)
- `CameraScanner.kt` (camera decode), `HoneywellScanner.kt` (CT40 imager via Honeywell **Data Collection Intent API**: claim `dcs.scanner.imager`, receive `ACTION_BARCODE_READ_EVENT` broadcasts; source label `EXTERNAL_SCANNER`; no-op on non-Honeywell), `ScanCoordinator.kt` + scanner-core (`ScanDecision` duplicate/debounce/empty guard; `OcrNormalizer` never accepts raw OCR text — scored candidates only). `[FACT]`
- `OfflineQueue.kt` — serialisable queue model with operationId dedupe, PENDING/SYNCING/SYNCED/FAILED, max 500; **persisted nowhere, synced by nothing**. `[PARTIAL — C-13]`
- Barcode formats/QR support on native is delegated to the device imager/camera stack; no format list is enforced app-side. `[FACT]`

### Backend scanner services
There is **no scanner service on the backend** — by design. The backend receives *operational events* with provenance fields; decode is a client concern. Validation (existence, shipment match, duplicates, quantity rules) is fully server-side. `[FACT]`

---

# 16. Device Detection

**Where it lives / how it identifies devices:**

| Layer | File | Mechanism |
|---|---|---|
| Web capability probe | `receiving-terminal/scan-source.ts` `detectCapabilities()` | UA regex + touch + viewport width ⇒ `SMARTPHONE \| TABLET \| DESKTOP \| UNKNOWN`; probes `getUserMedia`, `BarcodeDetector`, `onLine` |
| Web scan-method policy | `receiving-terminal/scan-method.ts` `chooseScanMethods()` / `deviceClassOf()` | pure function of the probe (unit-tested) |
| Native CT40 detection | `HoneywellScanner.isHoneywellDevice()` | `Build.MANUFACTURER/BRAND` contains "honeywell" (CT40/CT30/CN80…) |
| Native phone | implicit | non-Honeywell ⇒ camera is the scanner; `HoneywellScanner.start()` no-ops |
| Backend device registry | `Device` model + `devices` module | admin-registered **device codes** (`AYROVI-RCV-01`), status, model, appVersion, assignedWorker, stationCode snapshot, lastSeenAt/Ip |

- **CT40 behavior on native:** hardware imager (side trigger) is primary (`BigScanHero` hint "SCAN WITH CT40 TRIGGER"; camera is an opt-in toggle `CameraToggle` and CT40 units show "CT40 side-trigger is primary"). `[FACT]`
- **Reliability (report only):** web detection is heuristic (UA+width+touch) — reasonable but spoofable and resolution-dependent; native Honeywell detection is manufacturer-string based — CT40 units report Honeywell, but no model-level (CT40 vs CN80) differentiation exists; **no device model telemetry reaches the backend except the free-form `deviceType/deviceName` strings on sessions** and the registry `model` column. `[PARTIAL]`
- **Do components consume it?** Yes — `ReceivingTask` (`detectCapabilities` at mount, passes device info at session start, chooses scanner host), `PutawayTask`, `ReceivingScanner` (method default). Other screens reuse the shared scanner. `[FACT]`
- **Frontend-only?** The web detection is frontend-only. The backend knows device type only via (a) those free-form session strings, (b) the `Device` registry for WORKER_NATIVE logins (device-code authorization, first-use binding, last-seen touch, disable ⇒ live sessions revoked). `[FACT]`
- **Station capabilities consumed:** `stationHas(station,'OCR')` gates the OCR affordance; no capability ever blocks a workflow. `[FACT]`
- Improvement needs (REPORT ONLY): unify Station.deviceId (string) with the Device registry (FK); persist native OfflineQueue; send structured device class/model to the backend for analytics. `[RECOMMENDATION]`

---

# 17. Current Worker Flow

**CURRENT IMPLEMENTED FLOW (web worker terminal):**

```
/login?app=worker  (employeeCode + password/PIN)
   → WORKER_NATIVE session (device code optional in web; station captured if exactly 1)
   → /terminal  GET /terminal/context  (tasks I may run · my station · active sessions · resume)
        routing: open work (resume) > exactly-one-task auto-open > task picker > "NO TASK ASSIGNED"
   → admin-assigned tasks (WorkerTaskAssignment) listed first; completable with a note
   → task screen (e.g. RECEIVING): arrival picker → session → SCAN (camera/wedge/manual)
   → backend validation verdict (flash) → sound/colour/status footer
   → pause/resume/complete; offline badge when navigator.onLine = false
```

**NATIVE APP flow (as coded):** login (device code mandatory field, WORKER_NATIVE) → Home (station context + assigned tasks + station tiles) → station tabs → per-station scan screens with CT40 trigger/camera/manual → feedback bar + sounds + today counter. Trace tab is registry-unreachable (C-10). Receiving tab has the two breaks in C-1/C-2.

**MISSING / UNKNOWN (reported, not invented):**
- Worker-side notifications/new-work push (no WS/push to the worker; only SSE for admin Live board). `[MISSING]`
- Worker "shift start/end", break, task acceptance handshake. `[MISSING]`
- Offline execution end-to-end. `[MISSING]`
- Any flow forcing a worker to work **only** at their station's department. `[MISSING — no rule]`

---

# 18. Admin → Backend → Worker Data Flow (real endpoints)

```
ADMIN (or CRM)                    BACKEND                              WORKER
─────────────────                 ─────────────────────────────        ─────────────────
CRM pushes card ──▶ POST /integrations/arrivals/customer-cards  ──▶ ExpectedArrival EXPECTED
CRM pushes ship  ──▶ POST /integrations/arrivals/shipments      ──▶ Shipment+Cartons EXPECTED
Admin assigns    ──▶ POST /stations/:id/assign                  ──▶ Station.assignedWorkerId
Admin registers  ──▶ POST /devices (+/:id/assign)               ──▶ Device bound to worker
Admin instructs  ──▶ POST /operations/worker-tasks              ──▶ WorkerTaskAssignment OPEN
                                                                       │
Worker logs in   ◀── POST /auth/login {app:'WORKER_NATIVE', deviceId} ──┘ session(device,station)
Worker context   ◀── GET  /terminal/context
Worker executes  ──▶ POST /receiving/arrivals/:code/start · scan-carton · receive-carton
                       · receive-product · fulfillment scan-article · pause/resume/complete
                       · putaway start/scan/place · sorting scan/store · order-sorting · packing · ship
Backend validates + writes state + audit (+ flash verdict)  ──▶ worker UI verdict
Admin observes   ◀── GET /operations/overview|workers|sessions/:id|exceptions|activity|tasks|…
Admin corrects   ──▶ POST /operations/corrections/* (reverse-carton · correct-quantity ·
                       resolve-exception · reopen-session)  &  /operations/data-control/void
                       (each: reason mandatory, snapshot before/after, audit) → worker sees result
```

Key endpoint reference (auth: all JWT Bearer; **Perms** = `@RequirePermissions`; **App** = `@RequireApplication`):

| Endpoint | Method | Purpose | Perms | App | Writes |
|---|---|---|---|---|---|
| `/auth/login` | POST | login (+app, deviceId) | public (rate-limited) | — | Session |
| `/auth/me` | GET | identity + roles/perms + session binding | — | — | — |
| `/terminal/context` | GET | worker routing context | — | WORKER_NATIVE | — |
| `/terminal/assignments[/:id/complete]` | GET/POST | my assigned tasks | — | WORKER_NATIVE | TASK_COMPLETED |
| `/receiving/arrivals` | GET | receivable arrivals | receiving.view | — | — |
| `/receiving/arrivals/:id/active` | GET | active session for arrival | receiving.view | — | — |
| `/receiving/arrivals/:id/start` | POST | start/resume session | receiving.execute | — | session+lines, arrival→RECEIVING |
| `/receiving/sessions/:id` | GET | full session state | receiving.view | — | — |
| `/receiving/sessions/:id/scan-carton` | POST | identify carton (idempotent) | receiving.execute | — | event row / discrepancies |
| `/receiving/sessions/:id/receive-carton` | POST | commit receipt (idempotent) | receiving.execute | — | carton→RECEIVED |
| `/receiving/sessions/:id/receive-product` | POST | units × SKU | receiving.execute | — | line update / UNEXPECTED |
| `/receiving/sessions/:id/pause|resume` | POST | lifecycle | receiving.execute | — | session+arrival status |
| `/receiving/sessions/:id/flag` | POST | worker discrepancy | receiving.execute | — | discrepancy |
| `/receiving/sessions/:id/complete` | POST | close (supervisor if discrepancies) | receiving.execute | — | session/arrival final status |
| `/receiving/discrepancies/:id/resolve` | POST | resolve | receiving.resolve_discrepancy | — | discrepancy→RESOLVED |
| `/fulfillment/containers[/:code]` | GET/POST | totes & bins | receiving.view / receiving.execute (create) | — | container |
| `/fulfillment/receiving/sessions/:id/scan-article` | POST | piece → tote + ArticleUnit | receiving.execute | — | article + reconciliation |
| `/fulfillment/sorting/articles/:code` · `/sorting/store` | GET/POST | category sorting | stowing.execute | — | article→STORED |
| `/fulfillment/order-sorting/articles/:code` · `/assign` | GET/POST | customer bins | picking.execute | — | article→IN_CUSTOMER_BIN |
| `/fulfillment/packing/containers/:code[/pack]` | GET/POST | verify + pack | packing.execute | — | OutboundShipment |
| `/fulfillment/shipping/shipments/:code[/ship]` | GET/POST | dispatch | shipping.execute | — | →SHIPPED, bin CLOSED |
| `/fulfillment/articles…/trace` | GET | traceability | operations.view | — | — |
| `/putaway/queue|sessions…` | GET/POST | stowing | stowing.view/execute | WORKER_NATIVE | placements |
| `/stations…` (+assign/status) | CRUD | registry | stations.view/manage | ADMIN_WEB | station |
| `/devices…` | CRUD | device registry | stations.view/manage | ADMIN_WEB | device (+revokes) |
| `/operations/overview|workers|sessions|exceptions|activity|tasks|containers…` | GET | admin boards | operations.view | ADMIN_WEB | — |
| `/operations/corrections/*` | POST | audited corrections | operations.correct | ADMIN_WEB | correction + target |
| `/operations/data-control/*` | GET/POST | soft-void | operations.view/correct | ADMIN_WEB | VOIDED statuses |
| `/operations/workers/:id/block|unblock|remove` | POST | worker lifecycle | users.manage | ADMIN_WEB | user status + revokes |
| `/operations/worker-tasks…` | GET/POST | admin instructions | users.manage | ADMIN_WEB | assignments |
| `/integrations/arrivals/customer-cards · shipments`, `/integrations/orders` | POST | CRM intake | public + x-api-key guard | — | expected data |
| `/expected-arrivals…`, `/shipments…`, `/orders…` | GET | read projections | expected_arrivals.view / shipments.view / operations.view | — | — |
| `/categories…` | CRUD | category master + zone mapping | inventory.view/manage | ADMIN_WEB | config |
| `/live/events` | GET (SSE) | live admin feed | — | — | — |

---

# 19. State Machines

All transitions below are traced in code (service + method). "—" = no code path.

### ARRIVAL STATUS (`ExpectedArrivalStatus`)
| State | Meaning | Can enter from | Can exit to | Written by |
|---|---|---|---|---|
| EXPECTED | card received, goods not here | (CRM intake) | RECEIVING, VOIDED | intake; `dataControlVoid` |
| RECEIVING | session open | EXPECTED, PAUSED | PAUSED, RECEIVED, RECEIVED_WITH_DISCREPANCY, VOIDED | `start`, `resume`, `complete`, void |
| PAUSED | session paused | RECEIVING | RECEIVING, VOIDED | `pause` |
| RECEIVED | fully received, no discrepancies | RECEIVING/PAUSED | (reopened via corrections → RECEIVING) | `complete` |
| RECEIVED_WITH_DISCREPANCY | closed with issues | RECEIVING/PAUSED | (reopen → RECEIVING) | `complete` (supervisor) |
| VOIDED | admin soft-void | any non-void | — | `dataControlVoid` |

### RECEIVING SESSION (`ReceivingSessionStatus`)
RECEIVING ⇄ PAUSED (`pause`/`resume`) → COMPLETED | COMPLETED_WITH_DISCREPANCY (`complete`); corrections `reopenSession` → RECEIVING. **CANCELLED: reserved, never set by any code.** `[PARTIAL]`

### RECEIVING PRODUCT LINE (`ReceivingProductStatus`)
EXPECTED → PARTIALLY_RECEIVED → RECEIVED (received==expected); → OVERAGE (received>expected, discrepancy opened); → SHORT (flipped at completion with discrepancies); UNEXPECTED (unknown SKU line); NEEDS_REVIEW (seed line without SKU).

### RECEIVING CARTON EVENT (string status on `receiving_cartons`)
RECEIVED · UNKNOWN · WRONG_SHIPMENT · DUPLICATE (flash only, no row) · FLAGGED (reserved — never written) · **REVERSED** (admin correction — note: `'REVERSED'` is written although not in the doc'd string set).

### CARTON (`CartonStatus`)
EXPECTED → RECEIVED (`receiveCarton`) → STORED (`putaway.place`) ; RECEIVED → EXPECTED (correction `reverseCarton`) ; VOIDED (admin, only if not RECEIVED/STORED) ; FLAGGED / WRONG_SHIPMENT reserved-unwritten. `[PARTIAL]`

### DISCREPANCY (`DiscrepancyStatus`)
OPEN → RESOLVED (worker-side resolve by supervisor, or admin `resolveException`) ; REJECTED reserved (no code writes REJECTED).

### PUTAWAY SESSION (`PutawaySessionStatus`)
ACTIVE ⇄ PAUSED → COMPLETED ; CANCELLED reserved-unwritten.

### ARTICLE UNIT (`ArticleUnitStatus`)
created **IN_CONTAINER** (scan-article; enum default RECEIVED unused) → STORED (sortingStore) → IN_CUSTOMER_BIN (orderSortingAssign) → PACKED (pack) → SHIPPED (ship) ; VOIDED (admin void). No backwards transitions ("articles never return to the carton").

### OPERATIONAL CONTAINER (`ContainerStatus`)
ACTIVE → READY_FOR_PACKING (order complete) → PACKED (pack) → CLOSED (ship cleanup) ; VOIDED (admin).

### OUTBOUND SHIPMENT (`OutboundShipmentStatus`)
READY_TO_SHIP → SHIPPED (double dispatch rejected).

### WORKER TASK ASSIGNMENT (`AssignmentStatus`)
OPEN → DONE (worker, with note) | CANCELLED (admin, with reason); removal of a worker cancels open items.

### TASK STATUS ("Worker Task" availability)
No per-instance status: registry `ready` flag (all true) + permissions. Terminal cards show OPEN / SOON / IN PROGRESS (client-side). `[FACT]`

### STATION / USER / DEVICE / SESSION
Station: ACTIVE ⇄ INACTIVE, MAINTENANCE (no restrictions on transitions). User: ACTIVE → LOCKED ⇄ ACTIVE; → DISABLED (terminal). Device: ACTIVE ⇄ DISABLED (disable revokes bound sessions). Session: ACTIVE → EXPIRED/REVOKED (rotation revokes predecessor; disable/lock/station-change/device-change revoke live).

### SCAN STATUS
`ScanType` QR|BARCODE|MANUAL and `ScanSource` CAMERA|EXTERNAL_SCANNER|MANUAL — provenance labels, not states.

---

# 20. API Map

See §18 table (complete operational surface). Supplementary notes: global prefix `/api` + URI version `v1`; Swagger at `/api/docs` when enabled; validation pipe whitelist+forbidNonWhitelisted; rate limiting on auth; helmet + explicit CORS from `CORS_ORIGINS`; integration routes are `@Public()` but behind `IntegrationApiGuard` (static `WAREHOUSE_INTEGRATION_API_KEY` or registered API client `x-client-id`/`x-api-key`). `[FACT]`

---

# 21. Database Map

30+ models, 21 migrations (`backend/prisma/migrations/`), plus a runtime self-repair bootstrap (`bootstrap-schema-repair.ts`). Grouped:

- **Identity & access:** `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `Session`, `AuditLog`, `SystemSetting`, `ApiClient`, `Device`.
- **Physical structure:** `Warehouse`, `Zone`, `Aisle`, `Rack`, `Level`, `Location` (barcode-ready codes; capacity metadata only).
- **Classification config:** `CategoryMaster`, `CategoryZoneMapping`.
- **Inbound expectation:** `ExpectedArrival`, `ExpectedArrivalItem`, `WarehouseShipment`, `WarehouseCarton`.
- **Receiving execution:** `ReceivingSession`, `ReceivingCarton`, `ReceivingProduct`, `ReceivingDiscrepancy`.
- **Stowing:** `PutawaySession`, `CartonPlacement` (append-only ledger).
- **Operational flow:** `OperationalContainer`, `ArticleUnit`, `OutboundShipment`.
- **Admin control:** `WorkerTaskAssignment`, `OperationCorrection`.
- **Phase-2 identity (dormant):** `Product`, `WarehouseOrder`, `OrderItem`, `PhysicalItem`.

---

# 22. Operational Matrix (existing implemented tasks ONLY)

| Task | Purpose | Worker Role (seeded) | Station (required?) | Device | Scanner | Input | Output | Completion |
|---|---|---|---|---|---|---|---|---|
| Receiving | confirm expected cartons/units physically arrived | INBOUND_WORKER (also WAREHOUSE_ADMIN/MANAGER via API) | not required; recorded if assigned | any (phone camera / wedge / CT40 / desktop) | QR/barcode/OCR(affordance)/manual | arrival code (picked), carton code, SKU × qty, tote code | ReceivingSession + events + reconciliation (+ ArticleUnits) | `complete` → COMPLETED[_WITH_DISCREPANCY] (supervisor gate) |
| Putaway (carton stowing) | store RECEIVED cartons on locations | INBOUND_WORKER | not required | any | barcode/QR/manual (carton + location) | carton code, location code | CartonPlacement (append-only), carton STORED | session `complete` |
| Sorting (article storage) | route articles to category zone | INBOUND_WORKER (stowing.execute) | not required | any | article QR + location barcode/manual | ART- code, location code | article STORED + currentLocationId | per-article STORED |
| Order Sorting (customer bins) | assign articles to customer orders | PICKER | not required | any | article QR + bin QR | ART- code, BIN- code | article IN_CUSTOMER_BIN (+order), bin READY_FOR_PACKING | per-article; bin readiness |
| Packing | verify + pack complete orders | PACKER | not required | any (+ printer for label) | bin QR | BIN- code | OutboundShipment READY_TO_SHIP, articles PACKED | per-bin PACK |
| Shipping | dispatch outbound | **no OPERATIONAL role** `[C-5]` | seeded ST-SHP-01 exists | any | OUT- label | OUT- code | shipment SHIPPED, articles SHIPPED, bin CLOSED | per-shipment SHIP |
| Admin task instruction | attach work note to worker | (admin acts) | — | — | — | title/description/relatedCode | WorkerTaskAssignment | worker DONE(note) / admin CANCELLED |

Not implemented (must not be assumed): Transfer, Cycle Count, Inspection/QC, Returns, Loading, any picking-of-units from storage. `[MISSING]`

---

# 23. Worker Matrix (schema-level; runtime data unknown — seeded/test values shown)

| Worker (seed/test) | Role | Key permissions (operational) | Station | Tasks (registry) | Device |
|---|---|---|---|---|---|
| WORKER001 "Ahmed Ben Salah" | INBOUND_WORKER | receiving.view/execute, stowing.view/execute, expected_arrivals.view, shipments.view, stations.view | ST-REC-01 (seed) | receiving, sorting, putaway | none registered (web/terminal) |
| (any) PICKER account | PICKER | picking.view/execute | — | order-sorting | — |
| (any) PACKER account | PACKER | packing.view/execute | ST-PCK-01 exists (unassigned) | packing | — |
| — | *no SHIPPING role* | shipping.execute held only by ADMIN-class roles | ST-SHP-01 exists (unassigned) | shipping (inaccessible to floor) | — |
| ADMIN001 / Isco | SUPER_ADMIN | ALL | — | all (ADMIN_WEB surface) | — |
| `1234`, `12345` (prod, per docs) | role-less ACTIVE | none | — | none (no surface) | — |

Runtime production rows are not present in this checkout → exact live workers/station bindings `[UNKNOWN]`.

---

# 24. Station Matrix (seeded configuration; capabilities as configured, not inferred)

| Station | Department | Status | Assigned worker (seed) | Tasks (by dept convention — NOT enforced) | Capabilities (config) | Device |
|---|---|---|---|---|---|---|
| ST-REC-01 Receiving Dock 1 | RECEIVING | ACTIVE | WORKER001 | receiving | CAMERA, BARCODE_SCANNER, QR_SCANNER, OCR, SCALE | deviceId free-text (unset) |
| ST-REC-02 Receiving Dock 2 | RECEIVING | ACTIVE | — | receiving | CAMERA, BARCODE_SCANNER, OCR | — |
| ST-SRT-01 Sorting Bench 1 | SORTING | ACTIVE | — | sorting / order-sorting | CAMERA, BARCODE_SCANNER | — |
| ST-PCK-01 Packing Bench 1 | PACKING | ACTIVE | — | packing | CAMERA, PRINTER, SCALE | — |
| ST-SHP-01 Shipping Dock 1 | DISPATCH | ACTIVE | — | shipping | CAMERA, BARCODE_SCANNER, QR_SCANNER | — |
| *(no PUTAWAY station seeded)* | PUTAWAY | — | — | putaway | — | — |
| *(no INVENTORY station seeded)* | INVENTORY | — | — | — | — | — |

**Department↔task compatibility is convention only:** the backend never validates that a worker's station department matches the executed task. `[FACT — no rule]`

---

# 25. Receiving Detailed Map (dedicated)

```
RECEIVING
│
├── Definition ............ physical confirmation of Expected Arrival cartons/units; expected data immutable
│                           (receiving.service.ts header; schema comments)
├── Trigger ............... worker picks an arrival in EXPECTED (or resumes); CRM card is the upstream trigger
├── Task creation ......... self-started ReceivingSession (RCV-); NO TaskType instance; optional advisory
│                           WorkerTaskAssignment (ARRIVAL relatedCode) — not linked to the session
├── Assignment ............ none enforced (permission-gated); session pinned to starter but any
│                           receiving.execute actor may continue it (no worker lock)
├── Station ............... optional; resolved server-side from worker→station assignment; recorded on session
├── Worker permissions .... receiving.view (see), receiving.execute (do), receiving.resolve_discrepancy (close w/ issues)
├── Arrival ............... ExpectedArrival WAR- (status mirrored RECEIVING/PAUSED/RECEIVED*)
├── Shipment .............. primary = shipments[0]; wrong-shipment check ONLY against that one  [C-12]
├── Carton ................. WarehouseCarton CTN- (qr/barcode/reference); UNKNOWN/WRONG/DUPLICATE handling
├── Product ............... ReceivingProduct lines (SKU-aggregated seed, category snapshot CONFIRMED/NEEDS_REVIEW)
├── Scanner ............... web dual-scanner (desktop=hardware, phone=software) + manual; native CT40 imager + camera + manual
├── Validation ............ server-only: existence, shipment match, duplicate (operationId), SKU match, qty rules
├── Quantity .............. received += qty; difference stored; OVERAGE opens discrepancy; expected never touched
├── Discrepancy ........... typed, OPEN; resolve = supervisor permission (worker path) or admin correction (snapshot)
├── Confirmation .......... receive-carton commit (auto after identify on web); per-scan product accept
├── Completion ............ complete → tally gate → COMPLETED / COMPLETED_WITH_DISCREPANCY (+ arrival mirror,
│                           SHORT line flipping, audit)
├── Errors ................ 400 empty code; 404 unknown arrival/carton/session; 403 missing permission / non-supervisor close;
│                           409 closed session, already-received arrival, carton of other shipment
├── Offline behavior ...... NONE in production reality: web actions just fail; native OfflineQueue is an
│                           unwired in-memory model; scans are NOT replayed  [C-13]
└── Backend APIs .......... §18 receiving + fulfillment/scan-article block
```

---

# 26. Contradictions (Admin UI vs Backend vs Database vs Native)

Severity scale: CRITICAL / HIGH / MEDIUM / LOW. **None were fixed.**

| ID | Severity | Contradiction | Evidence |
|---|---|---|---|
| **C-1** | **HIGH** | **Native Receiving shows "CARTON RECEIVED" without persisting a receipt.** `scan-carton` only *identifies* (flash `CARTON_IDENTIFIED`); the receipt write is `receive-carton`. The native UI treats `CARTON_IDENTIFIED`/`CARTON_RECEIVED`/`CARTON_CONFIRMED` identically as received and **never calls `receiveCarton`** (defined in `WorkerRepository` but unused by `Screens.kt`). Cartons scanned on a CT40 stay EXPECTED in the DB while the operator sees a green ✓; tally fallback (`receivedCartons >`) never increments. | `mobile/.../Screens.kt` ReceivingStation `onScan`; `receiving.service.scanCarton` vs `receiveCarton`; web `ReceivingTask.submitCarton` (auto-confirm) |
| **C-2** | **HIGH** | **Native session buttons check the wrong status literal.** UI branches on `s.status == "ACTIVE"`; the backend's active receiving status is **`RECEIVING`**. Result: PAUSE never renders during an active session and COMPLETE is disabled (`enabled = … ("ACTIVE" || "PAUSED")`) except after a web-side pause. | `Screens.kt:1019,1036` vs `ReceivingSessionStatus` enum |
| **C-3** | **MEDIUM** | **Application-surface guard missing on the core worker controllers.** `@RequireApplication` is opt-in; `receiving`, `fulfillment`, `expected-arrivals`, `shipments`, `orders`, `live` have none. An ADMIN_WEB session (WAREHOUSE_ADMIN/MANAGER hold `receiving.execute`) can execute worker operations via API, and a WORKER_NATIVE session can call those read endpoints — contrary to the strict-isolation design the guards docstring advertises ("the API never lets an ADMIN_WEB session act as a worker context"). Permission checks still apply; this is a surface-isolation gap, not an RBAC bypass. | grep `@RequireApplication` across `backend/src` (list in audit); `application.guard.ts` docstring |
| **C-4** | **MEDIUM** | **Product/article scans are not idempotent server-side.** `operationId` exists only for cartons (`receiving_cartons.operationId` unique). `receive-product` and `fulfillment scan-article` have no dedupe; a network retry double-counts units (clients send `operationId`, backend ignores it). | controller bodies; schema; `WorkerRepository.receiveProduct` sends unused `operationId` |
| **C-5** | **MEDIUM** | **Shipping task is code-ready but unreachable for the floor.** `shipping.execute` is granted only to ADMIN-class roles; no OPERATIONAL role exists ⇒ the Shipping terminal cannot be staffed; seeded station ST-SHP-01 has no eligible worker class. | `prisma/seed.ts` role grants; TASK_REGISTRY |
| **C-6** | **MEDIUM** | **Putaway queue has no claim/lock.** The queue is a shared list; two stowing workers can work the same carton. `place()` is data-safe (idempotent no-op) but work duplication and racing sessions are possible. | `putaway.service.queue/place` |
| **C-7** | **LOW** | **Role-name vs task-permission mismatch.** "Sorting" (category storage) runs on `stowing.execute` (INBOUND_WORKER), while the operating-model doc maps "SORTING WORKER = PICKER" (which actually drives *Order Sorting* on `picking.execute`). Confusing for role design; documented as name mapping only. | TASK_REGISTRY; `docs/WORKFORCE-OPERATING-MODEL-P2-FINAL-REPORT.md` §2 |
| **C-8** | **LOW** | **Two disconnected device concepts.** `Station.deviceId` is a free string; the admin-managed `Device` registry (auth, binding, revocation) is separate. A station can name a device that isn't registered; registering a device doesn't link the station. | schema `Station.deviceId` vs `Device` |
| **C-9** | **MEDIUM** | **Phase-2 identity layer is orphaned.** `Product/OrderItem/PhysicalItem` (+ permissions) exist; no controllers write products/order-items/physical-items; `WarehouseOrder`s are created only via CRM `/integrations/orders` and read via admin Orders board. `PhysicalItemStatus.RECEIVED/STOWED/...` reserved but ArticleUnit is the real piece model — two parallel piece models now coexist. | modules list (no products/order-items controllers); schema comments |
| **C-10** | **LOW** | **Native tabs for TOTE and TRACE are unreachable.** `StationKey.fromKey` maps keys `receiving-container` / `archive-trace`, which TASK_REGISTRY never emits, so those bottom-bar tabs never render (their screens are dead code paths in practice). | `Screens.kt` StationKey vs TASK_REGISTRY |
| **C-11** | **MEDIUM** | **"Task" semantic duplication.** Registry task types (always available) vs `WorkerTaskAssignment` (instructions) vs sessions are three unconnected layers; completing an admin task writes only a note and has no effect on the operational workflow it references. | terminal.service; operations.service |
| **C-12** | **HIGH** | **Multi-shipment arrivals break receiving.** The session validates cartons only against `arrival.shipments[0]` (primary). An arrival with 2+ shipments: cartons of the second shipment are rejected `WRONG_SHIPMENT` (they belong to the same arrival), and expected-carton tally counts ALL shipments' cartons — guaranteed discrepancies. | `receiving.service.start/scanCarton/reconcile` |
| **C-13** | **MEDIUM** | **Offline support claimed at model level only.** `OfflineQueue` is in-memory, unpersisted, with no sync worker; no endpoint consumes queued envelopes. Native UI shows OFFLINE but drops work. | `mobile/scanner-core/OfflineQueue.kt`; no consumer |
| **C-14** | **LOW** | **Seed catalog lists `receiving.view`/`receiving.execute` twice** (harmless upserts, but the count "74 permissions" double-counts two keys). | `prisma/seed.ts` PERMISSIONS array |
| **C-15** | **MEDIUM** | **Documentation drift.** Root audit (`AYROVI_WAREHOUSE_FULL_DISCOVERY_AUDIT.md`) and parts of `docs/WAREHOUSE-OS-STATUS.md` describe sorting/packing `ready:false`, no fulfillment, no isolation — all outdated vs current code. Decisions based on them would be wrong. | compare docs vs `TASK_REGISTRY`, `fulfillment/`, guards |
| **C-16** | **LOW** | **`flag` endpoint has no UI.** Backend supports worker-raised discrepancies (`/sessions/:id/flag`); neither web nor native terminal exposes a flag button. | controller vs UI grep |
| **C-17** | **LOW** | **Worker web login trap.** A floor worker must know to use `/login?app=worker`; plain `/login` is ADMIN_WEB and is rejected for OPERATIONAL roles with the correct message, but the login screen exposes no worker-mode toggle/link — discovery depends on the URL. | `pages/Login.tsx`; `auth.service.applicationDenyMessage` |
| **C-18** | **LOW** | **Reserved enum values never written**: ReceivingSession CANCELLED, Putaway CANCELLED, Carton FLAGGED/WRONG_SHIPMENT, Discrepancy REJECTED, ArticleUnit RECEIVED (default unused). Dead states confuse state-machine readers. | services grep |

---

# 27. Missing Definitions (required before Worker App implementation)

Each item: status only — no assumed answer.

| # | Missing definition | Status |
|---|---|---|
| 1 | Who may perform Receiving (dedicated receiving role vs INBOUND_WORKER bundle) | PARTIALLY IMPLEMENTED (INBOUND_WORKER; managers/admins also hold execute — see C-3) |
| 2 | Can a receiving worker work at multiple stations? | IMPLEMENTED as "one station max" (station side); worker-side parallelism undefined — a worker can run tasks of any department |
| 3 | Can a worker claim an unassigned receiving session/arrival? | IMPLEMENTED implicitly: any receiving.execute worker may open/continue — no claim semantics; formal policy UNKNOWN |
| 4 | Is arrival scan mandatory to start? | NOT IMPLEMENTED (list-pick; typed id-or-code accepted) |
| 5 | Are carton scans mandatory before product scans? | NOT IMPLEMENTED (no ordering rule) |
| 6 | Are product scans mandatory (vs counting)? | NOT IMPLEMENTED (quantity entry alone works; unit-count-only mode unknown) |
| 7 | Quantity mismatch handling | IMPLEMENTED (OVERAGE/SHORT discrepancies) — but *who resolves, when, and SLAs* UNKNOWN |
| 8 | Who resolves discrepancies (role model)? | PARTIALLY IMPLEMENTED (permission exists; no dedicated DISCREPANCY_MANAGER role) |
| 9 | Can receiving complete offline? | NOT IMPLEMENTED |
| 10 | Behavior when CT40 loses network mid-session | PARTIALLY IMPLEMENTED (badge + failed calls; no queue/replay) |
| 11 | Damaged goods capture | NOT IMPLEMENTED |
| 12 | Station↔task/department compatibility rules | NOT IMPLEMENTED (recorded, never validated) |
| 13 | Multi-shipment receiving policy | NOT IMPLEMENTED (broken — C-12) |
| 14 | Worker shifts / presence / availability model | NOT IMPLEMENTED |
| 15 | Task prioritisation / SLA / sequencing for workers | NOT IMPLEMENTED (resume > single task > picker only) |
| 16 | Shipping worker role | NOT IMPLEMENTED (C-5) |
| 17 | Receiving completion sign-off (e.g. second person, photo) | NOT IMPLEMENTED (permission gate only) |
| 18 | What happens to open sessions when a worker is blocked/removed | PARTIALLY IMPLEMENTED (sessions revoked; receiving session itself stays RECEIVING and is resumable by others — explicit policy UNKNOWN) |
| 19 | Scanner telemetry server sink / device analytics | NOT IMPLEMENTED (client-side only; Device.lastSeen is the only server signal) |
| 20 | Label printing standard (bins/totes/shipments) | PARTIALLY IMPLEMENTED (browser print-label helper web-side; no printer integration) |

---

# 28. Risks

1. **Native receiving data integrity (C-1/C-2):** floor use of the CT40/phone app today would show false "received" states — operational truth diverges from worker perception. `HIGH`.
2. **Surface isolation gap (C-3):** receiving/fulfillment executable from ADMIN_WEB sessions; widens the blast radius of admin credential theft and violates the stated isolation invariant. `MEDIUM`.
3. **Multi-shipment arrivals (C-12):** any arrival announced with >1 shipment cannot be received cleanly; forced discrepancies. `HIGH` (depends on CRM card patterns — frequency `UNKNOWN`).
4. **Double-counting on retries (C-4):** unit-level scans are non-idempotent; flaky floor Wi-Fi ⇒ silent inventory drift. `MEDIUM`.
5. **Unclaimed putaway queue (C-6):** duplicated labor, racing sessions. `MEDIUM`.
6. **Doc drift (C-15):** planning off the older audit produces wrong conclusions. `MEDIUM`.
7. **Role gap for shipping (C-5):** dispatch unstaffable without granting admin-class roles. `MEDIUM`.
8. **No offline story (C-13):** single-network-point-of-failure for the floor. `MEDIUM` (product decision pending).
9. **Orphaned Phase-2 identity layer (C-9):** two parallel piece models (PhysicalItem vs ArticleUnit) risk future divergence. `MEDIUM`.
10. **SKU namespace assumption (§14):** CRM arrival SKUs vs order product codes are matched by string equality with no validation — cross-system code drift breaks packing completeness silently. `UNKNOWN/MEDIUM`.

---

# 29. Recommendations (NOT current behavior — future proposals only)

1. Fix native receiving to call `receive-carton` after identify and branch on `RECEIVING` (C-1/C-2) **before** any CT40 pilot.
2. Add `@RequireApplication('WORKER_NATIVE')` (or an explicit dual-surface decision) to receiving/fulfillment, with isolation e2e tests extended to those routes (C-3).
3. Extend `operationId` idempotency to `receive-product`/`scan-article` (schema + service) (C-4).
4. Define receiving for multi-shipment arrivals: either per-shipment sessions or validate against the arrival's full shipment set (C-12).
5. Introduce a `SHIPPING_WORKER` OPERATIONAL role (or grant `shipping.execute` to a floor role) once business confirms dispatch staffing (C-5).
6. Add claim/lock (or assignment) semantics to the putaway queue (C-6).
7. Decide the piece model: either retire PhysicalItem or map ArticleUnit onto it (C-9).
8. Persist and sync the native OfflineQueue against idempotent endpoints (C-13).
9. Replace `Station.deviceId` string with a Device FK (C-8).
10. Refresh/supersede the stale discovery docs (C-15).
11. Expose the worker `flag` action in the terminal UI (C-16) and a worker-mode link on the login page (C-17).
12. Add station-department↔task validation if the business wants stations to constrain work (currently convention only).

---

# 30. Questions Requiring Business Decision

1. Should managers/admins be able to *execute* receiving (current: yes via permission + missing surface guard), or is execution floor-only?
2. Is receiving multi-shipment per arrival a real CRM scenario? Required behavior (sequential shipments / all-cartons pool)?
3. Is the Arrival (WAR-) barcode scan to start a session required, or is list-picking acceptable?
4. Must cartons be scanned before units? Must every unit be scanned (piece level) or are bulk quantities allowed?
5. Who closes discrepant receivings in production (WAREHOUSE_MANAGER via terminal? admin only?) and within what SLA?
6. Is offline receiving/putaway a launch requirement for the Worker App, or online-only first?
7. Which role should dispatch shipments on the floor, and should a `SHIPPING_WORKER` role be created?
8. Should stations restrict which tasks a worker may execute (department compatibility), or remain informational?
9. Damaged-goods handling: new discrepancy type + station capability? Photo evidence?
10. Is the PICKER/“sorting worker” naming acceptable long-term, or should roles be renamed to match the flow (renaming is a business-entity change — blocked until approved)?
11. Should admin `WorkerTaskAssignment`s eventually gate/open real workflow sessions (linking the two task layers), or stay an advisory checklist?
12. Which device classes must be supported day one (CT40 only? personal phones? shared tablets?) — impacts auth (device registry) and scanner defaults.

---

# 31. Implementation Readiness

```
WORKER APP READY:  PARTIAL
RECEIVING READY:   PARTIAL   (backend: YES · native client: NO · web client: YES)
CT40 READY:        PARTIAL   (imager integration real; receiving flow broken by C-1/C-2; offline not wired)
PHONE READY:       PARTIAL   (web terminal: YES via browser · native app: same breaks as CT40)
```

**BLOCKERS BEFORE WORKER IMPLEMENTATION:**

1. Native receiving does not commit carton receipts (C-1) — every KPI shown on the device is false.
2. Native session state literal mismatch `ACTIVE` vs `RECEIVING` (C-2) — pause/complete unusable on device.
3. Receiving/fulfillment application-surface policy undefined/un-enforced (C-3) — cannot state who may call worker APIs from which surface.
4. Multi-shipment arrival behavior undefined and currently broken (C-12).
5. Quantity-discrepancy resolution ownership (role/SLA) undefined (§27-8).
6. Unit-scan idempotency missing (C-4) — retry safety for the Worker App.
7. Shipping executor role undefined (C-5).
8. Offline requirement undecided; queue unwired (C-13).
9. Station↔task compatibility rules undefined (currently informational only).
10. Arrival-scan / carton-before-product ordering rules undefined (§27-4/5/6).

---

# FINAL OUTPUT — NO CODE CHANGES

**FILES INSPECTED (selection — every claim above cites its file):**
Backend: `prisma/schema.prisma`, `prisma/seed.ts`, all 21 migrations (titles), `src/app.module.ts`, `src/main.ts`, `src/bootstrap-schema-repair.ts` (title), guards (`jwt-auth`, `permissions`, `application`, `rate-limit`), `access/application-access.ts`, `modules/auth/*` (controller/service/jwt.strategy/token), `modules/users|roles|permissions|audit|system(+live, api-clients)/*`, `modules/devices/*`, `modules/warehouse/*` (controllers), `modules/expected-arrivals/*`, `modules/shipments/*`, `modules/orders/*`, `modules/receiving/*`, `modules/putaway/*`, `modules/fulfillment/*`, `modules/categories/*`, `modules/operations/*` (terminal, stations, corrections, operations.service), `integrations/crm/*`; `test/*.e2e-spec.ts` (titles).
Frontend: `App.tsx`, `pages/Login.tsx`, `context/AuthContext.tsx`, `api/*`, `shell/GlobalShell.tsx` (title), `terminal/*` (WorkerShell, WorkerTerminalHome, api, ReceivingTask, PutawayTask, SortingTask, OrderSortingTask, PackingTask, ShippingTask, fulfillment-api, putaway-api, print-label), `admin/api.ts`, `admin/pages/{Workers,Stations,Tasks,ControlCenter,…}.tsx` (key pages), `modules/receiving/api.ts`, `modules/receiving-terminal/{scan-source,scan-method,ReceivingScanner,ContinuousScanner(partial),HardwareScannerPanel(title),…}`.
Mobile: `MainActivity.kt`, `ui/Screens.kt`, `data/{WorkerRepository,Dtos,SessionStore(titles)}`, `scanner/{HoneywellScanner,ScanCoordinator,CameraScanner(title)}`, `scanner-core/{OfflineQueue,ScanDecision,OcrNormalizer}`.
Docs/config: `.env.example` (root/backend/frontend), `README.md`, `AYROVI_WAREHOUSE_FULL_DISCOVERY_AUDIT.md`, `docs/{WAREHOUSE-OS-STATUS,OPERATIONAL-FLOW-REPORT,WORKFORCE-OPERATING-MODEL-P2-FINAL-REPORT,NATIVE-WORKER-APP-EXECUTION-PLAN,RECEIVING-TERMINAL,…}.md` (cross-checked, not trusted as source of truth).

**FILES MODIFIED:** NONE

**FILES CREATED:** `AYROVI_OPERATIONAL_MODEL_DISCOVERY.md` (this document — diagnostic artifact only)
