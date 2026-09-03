# AYROVI — Native Worker App: Architecture Audit & Master Execution Plan

> Status: **v1 draft — engineering baseline** (produced from a full code review of the
> current repository, commit `58b94d3` + indicators `09989c3`).
> This document implements **P0.1 (Architecture audit)** of Order #1 and the planning
> requirement of Orders #2/#3 ("before touching files, present a short plan"). It is a
> **plan document, not a scanner order**; the Receiving web reference
> (`RECEIVING-SCANNER-FINAL-ORDER.md`) stays authoritative for the web scanner until
> the product decides to migrate stations to the native app.

---

## 0. Honesty & operating constraints (unchanged, mandatory)

1. **No fabricated evidence.** Anything claiming to be "built/tested on Android" must
   actually run on Android. This sandbox has **no Android SDK, no emulator, no device**,
   so no native artifact is claimed as verified here.
2. **Nothing that exists is broken.** The Admin Web + Warehouse Core + Receiving web
   scanner are production values; every change is additive and verified by the repo's
   existing test suites before commit.
3. **No shortcuts on the critical path.** Foundation (backend authorization) is built and
   unit-tested before UI/native breadth.
4. Any DB change ships as a **Prisma migration** and is applied only through the normal
   deploy (`start.sh`) — never a destructive reset in production.
5. Engineering principle used below: **the Native Worker App is a thin client over the
   same Warehouse Core**. Business logic lives in the Backend (single source of truth).

---

## 1. Current-state audit (what the code review found)

### 1.1 Backend — NestJS + Prisma + PostgreSQL (`backend/`)

Already in place (verified):

| Area | Found | Notes |
|---|---|---|
| Auth | `modules/auth` — login (password **or PIN** via `pinHash`), bcrypt, refresh-token rotation, per-user `Session` rows (ACTIVE/REVOKED, expiry, `refreshTokenHash` only — never plaintext) | `User.employeeCode` unique = the natural **Worker Key** |
| Session revoke | `Session.status=REVOKED` + `AuthService.revokeSession/revokeAllSessions`; JWT strategy rejects non-ACTIVE sessions per request | Immediate revocation ready |
| Roles/Permissions | `Role`, `Permission`, `UserRole`, `RolePermission`; seeded roles `SUPER_ADMIN`, `WAREHOUSE_ADMIN`, `WAREHOUSE_MANAGER`, `INBOUND_WORKER`, `PICKER`, `PACKER`, `VIEWER`; granular keys `receiving.execute`, `packing.execute`, `stations.manage`, … | Data-driven; server-side |
| Enforcement | `PermissionsGuard` (global RBAC from DB on **every** request) + `@RequirePermissions(...)` | Client cannot grant itself anything |
| Audit | `AuditLog` + `AuditService` (`USER_LOGIN`, `USER_LOGIN_FAILED`, `USER_LOGOUT`, …) | Ready for security events |
| Stations | `Station` model (type/location/status/assigned workers) + `modules/operations` (stations/terminal) | Worker/station binding partially present |
| Tasks | `WorkerTaskAssignment` | Some worker-control exists |
| Events | `@nestjs/event-emitter` (`modules/events`) | In-process events; **no external realtime bus yet** |
| Receiving | `receiving.*` permissions + sessions/cartons/products/discrepancies models + API | Same core the worker app will call |

### 1.2 Frontend — React + Vite (`frontend/`)

- Admin-oriented web (Control Center, users/roles/permissions/audit screens exist).
- Worker tasks currently run **in the same web app** (Receiving/Packing/etc. + the
  **web scanner** with phone-camera SOFTWARE mode + HARDWARE wedge mode).
- Level-2 OCR engine (PP-OCRv3 in TS) added this session, opt-in, default unchanged.
- `detectCapabilities()`/`chooseScanMethods()` → device-class-based method pick today.

### 1.3 Gap map vs the three Orders

| Requirement (Order #) | Existing | Gap |
|---|---|---|
| Worker identity + key (O2) | `User.employeeCode` + PIN login | No dedicated "worker" profile/registration flow on Admin |
| Role→app separation: ADMIN_WEB vs WORKER_NATIVE (O3) | Roles exist | **No Application context** anywhere (session/token/guard) |
| Server-side app isolation (O3 core) | RBAC guard | **Missing** — login doesn't know which app; no deny tests |
| Station/role dynamic assignment (O2) | `Station`, `UserRole`, `WorkerTaskAssignment` | No end-to-end assignment API the app consumes; no "current assignment" resolution |
| Device entity/binding (O1/O3) | none | **New `Device` model** + registration/authorization |
| Worker workflow per station (O2) | none (web pages) | Workflow catalog driven by assignment (backend returns allowed workflow) |
| Scanner Core reuse (O1/O3) | web scanner + level-2 engine exist in frontend | Native layer must reuse the *protocol* (same validation/telemetry shape) |
| Native Android app (O1) | none | **New `mobile/` Kotlin project** |
| Offline queue + sync (O1) | none | New worker-side queue + idempotent sync endpoint |
| Realtime to worker (O2/O3) | event-emitter (in-proc) | Poll/SSE/WS bridge or lightweight push for session revocation + assignment refresh |
| Scanner telemetry to Admin (O1/O3) | telemetry exists client-side only | Backend telemetry sink + Admin monitoring screens |

---

## 2. Technology decision (with reasons)

| Layer | Choice | Why |
|---|---|---|
| Worker app | **Native Android — Kotlin + Jetpack Compose** | Order forbids a WebView wrapper; native gives real camera control, foreground service scanning, vibration/sound, offline queue, fast startup |
| Camera/scan | **CameraX + ML Kit Barcode Scanning (bundled, on-device)** | Industrial-grade autofocus/exposure/frames; native ML Kit is the strongest on-device code reader (better than browser WASM) |
| OCR | **ML Kit Text Recognition (on-device)** feeding the same validation pipeline; the proven TS PP-OCR engine stays as the **web/fallback reference** | OCR must not be trusted raw: confidence + format + expected-match gates replicated server-side/client-identically |
| App architecture | **MVVM + single-activity + Navigation** with a **reusable ScannerCore** Kotlin library module | Order: one scanner core, many station workflows |
| Local storage | **EncryptedSharedPreferences / Keystore** for tokens; **Room** for offline queue | Order: no plaintext secrets; offline operations carry full identity+sequence, idempotent sync |
| Sync/revocation | Backend endpoints idempotent + short-lived access token (15m) + revocation via session row; background refresh + pull of "session/assignment status" every N s and on resume | No new realtime bus needed at P0 (cheap, robust); WS/SSE later |
| Backend | **Unchanged NestJS/Prisma** — extend | Max reuse, single source of truth |
| Build/verify | `mobile/` builds only where the Android SDK exists (CI/your machine); **every pure Kotlin rule has JVM unit tests**; integration is validated with the documented runbook | Honesty constraint #1 |

**Rejected**: Capacitor/WebView (explicitly forbidden), pure-PWA-as-the-app (loses native
camera/foreground/offline guarantees the Orders require), per-station separate apps.

---

## 3. New APIs / new backend surface (design, not yet implemented)

1. `POST /auth/login` — gains an optional, **server-adjudicated** `application`
   (`ADMIN_WEB` default for the web; `WORKER_NATIVE` for the app). Server decides from
   the identity + role class; **never trusts the client**.
2. `GET /worker/context` — after login returns the single allowed `WorkflowContext`
   (role, station, assigned workflow, expected types, allowed actions, device binding).
3. `POST /devices/register` + `POST /devices/heartbeat` (+ Admin `devices.manage`).
4. `POST /receiving/scan` style endpoints remain the authority; worker app calls them
   with its session + device. **No duplicated Receiving logic inside the app.**
5. `POST /sync/offline-batch` — idempotent (client `localSequence` + server dedupe).
6. `POST /auth/session/revoke` (exists) → worker app receives 401 → forced re-login.

---

## 4. Phased roadmap (each phase = code + tests + commit)

Legend: 🟩 can be fully built & unit-verified in this sandbox · 🟦 needs Android SDK/device
(this sandbox prepares the structure + JVM-testable logic; final build/test on your machine
or CI) · all backend phases are 🟩.

### Track A — Backend authorization foundation (Order #3 first — it gates everything)
- **A1 🟩 Application access domain** — pure types + role→application policy + decision
  function + Jest acceptance tests for Order#3 scenarios 1–8. *(this plan's first slice)*
- **A2 🟩 Application context in tokens/session** — `app` claim in access+refresh JWTs and
  in the DB `Session` (additive migration, default `ADMIN_WEB`); login/refresh carry it.
- **A3 🟩 Server-side guards** — `ApplicationGuard`/policy check on worker/admin controllers;
  security audit events (`ADMIN_WEB_ACCESS_DENIED`, `WORKER_NATIVE_ACCESS_DENIED`, …).
- **A4 🟩 Worker context endpoint** — resolves current assignment (role+station+permissions
  from DB) → returns the single workflow the app may render.

### Track B — Worker/Device/Station management (Order #2)
- **B1 🟩 Device model + migration + register/heartbeat + authorize** (+ Admin CRUD).
- **B2 🟩 Worker assignment APIs** (assign role/station/device, disable, revoke).
- **B3 🟦 Admin Web screens** — Worker/Device/Station management + Scanner monitoring.

### Track C — Worker API surfaces Receiving consumes (Order #1/§9)
- **C1 🟩 Offline batch sync (idempotent) + dedupe** (+ tests).
- **C2 🟩 Scanner telemetry sink + `scan_*` events to AuditLog/DB** (+ Admin queries).

### Track D — Native Android Worker App (Order #1)
- **D1 🟦 Project scaffold** — Gradle multi-module: `:scanner-core`, `:app`; Compose shell;
  single-activity; theme matching Admin.
- **D2 🟦 Auth + context boot** — login (PIN), store tokens in Keystore/EncryptedPrefs,
  load `WorkflowContext`, render the ONE workflow the role/station allows; no Admin UI
  included.
- **D3 🟦 ScannerCore (Kotlin)** — CameraX preview + ML Kit barcode + text; continuous
  scan, autofocus/exposure, duplicate/debounce, SUCCESS (sound+vibration+visual) /
  failure-with-reason; **pure decision logic (accept/reject rules) JVM-unit-tested in
  sandbox**; device-only parts validated by runbook.
- **D4 🟦 Receiving workflow in the app** — calls existing receiving APIs; maps web
  scanner UX (card-open prefetch, local expected set, prefix-aware aim hints).
- **D5 🟦 Offline queue + sync + revocation handling** in-app.
- **D6 🟦 Admin scanner monitoring screen** (web) over telemetry sink.

### Track E — Rollout beyond Receiving (after Receiving is green on device)
Sorting → Packing → Shipping → Inventory, each a workflow definition consuming ScannerCore.

---

## 5. Acceptance tests (automated) per critical Order #3 slice — A1 first

`application-access.spec.ts` will encode, at minimum:

| # | Scenario | Expected |
|---|---|---|
| 1 | Admin credentials + `WORKER_NATIVE` | **Denied** — no worker session |
| 2 | Worker credentials + `ADMIN_WEB` | **Denied** — no admin session |
| 3 | Worker + unauthorized station | Denied (station check) |
| 4 | Worker + unauthorized permission | Denied (permission check) |
| 5 | Disabled worker + valid credentials | Authentication rejected |
| 6 | Revoked device + valid worker | Device authorization rejected |
| 7 | Client claims `role=ADMIN` | Backend ignores it, uses server identity, rejects |
| 8 | Valid worker + device + station + permission | Allowed — workflow accessible |

Rows 1–2/7 are pure → A1. Rows 3–6 need DB/device layers → A3/B1 phases.

---

## 6. Repository layout to be added

```
mobile/                     # new: Kotlin Worker App (built outside this sandbox)
  settings.gradle.kts, app/, scanner-core/
backend/prisma/migrations/  # additive migrations only
backend/src/modules/access/ # A1-A3: application access domain + guards
backend/src/modules/workers/…  # worker/device/assignment APIs (B)
backend/src/modules/sync/…     # offline batch sync (C1)
frontend/src/…/admin           # device/worker/telemetry screens (B3/D6, later)
docs/NATIVE-WORKER-APP-EXECUTION-PLAN.md   # this plan (living doc)
```

---

## 7. Immediate next action

Execute **A1** (application access domain + acceptance tests) in this session, run the
backend unit suite, commit, push — then proceed to A2, A3, … in subsequent steps without
stopping. Nothing in A1–A3 changes current web behaviour (default `ADMIN_WEB`).
