# AYROVI Warehouse Core — Strict Isolation + Native Worker OS: Implementation Plan

Status: active — audit complete, phased execution in progress.
Scope source: the three project commands (Admin/Worker strict isolation,
Dynamic Worker & Station Architecture, Native Worker App Architecture).

Progress:
- Batch 1 (HTTP surface enforcement) — DONE, CI green.
- Batch 2 (devices + session binding + revocation + security events) — DONE.
- Batch 3 (data-driven role classification) — DONE.
- Batch 4 (native Android app, scanner-core, workflows) — next.

This document is the short implementation plan requested BEFORE touching
source files. It records what already exists (never re-do), what is missing
(do it), and how each phase is proven.

---

## 1. Architecture audit summary (P0.1 — DONE)

### Already implemented in the codebase — DO NOT re-implement
| Area | Where | Evidence |
|---|---|---|
| Application kind enum | Prisma `ApplicationKind` (ADMIN_WEB, WORKER_NATIVE) | `backend/prisma/schema.prisma` |
| Session carries application | `Session.application` default ADMIN_WEB | same |
| Server-side access kernel | `src/modules/access/application-access.ts` (`evaluateAccess`, `classifyRole`, `applicationsAllowedByRoles`) | full chain: account → app → permission → station → device |
| Strict login gate (cross-app DENY) | `AuthService.login` resolves roles from DB and evaluates app before creating a session | `src/modules/auth/auth.service.ts` |
| Server truth per request | `JwtStrategy` reloads user/roles/permissions from DB on every request; checks session ACTIVE + user ACTIVE + app-claim match | `src/modules/auth/strategies/jwt.strategy.ts` |
| RBAC guard | global `PermissionsGuard` + `@RequirePermissions` | `src/common/guards/permissions.guard.ts` |
| Application surface guard machinery | `ApplicationGuard` + `@RequireApplication` (was defined but **not enforced on any route**) | `src/common/guards/application.guard.ts` |
| Roles/permissions seed model | SUPER_ADMIN, WAREHOUSE_ADMIN, WAREHOUSE_MANAGER, INBOUND_WORKER, PICKER, PACKER, VIEWER with granular permission keys | `backend/prisma/seed.ts` |
| Worker terminal context | `/terminal/context` resolves station + permitted tasks + assignments server-side | `src/modules/operations/terminal.service.ts` |
| Station as real entity | Station: department, status, assignedWorkerId, deviceId, capabilities | schema |
| Audit service + rich actions | central `AuditService` (login, user/role/permission, station, task, receiving…) | `src/modules/audit/` |
| Acceptance unit tests (kernel) | Test 1–8 of Order isolation | `src/modules/access/application-access.spec.ts`, `application.guard.spec.ts` |

### Missing / partial — implement (ordered)
| # | Gap | Detail |
|---|---|---|
| G1 | **Surface boundary not enforced at HTTP layer** | `ApplicationGuard` was never registered as APP_GUARD and no controller declared `@RequireApplication`. Admin-web sessions holding `receiving.execute` (WAREHOUSE_ADMIN/MANAGER grants) could call worker endpoints from the admin surface; worker sessions could call admin CRUD if they held the key. |
| G2 | Security events for denied access / revocation | Audit has login failures but no dedicated `APP_ACCESS_DENIED`/`SESSION_REVOKED` events and revocations are not audited everywhere. |
| G3 | Admin disable/role/station change → live session invalidation | JWT strategy already rejects disabled users on next request, but admins do not proactively revoke sessions at the moment of change. |
| G4 | Device entity + worker device binding | No `Device` model; only `Station.deviceId` and receiving session `deviceType/deviceName`. `DEVICE_NOT_AUTHORIZED` exists in the kernel but nothing feeds it. Doc1 §7, Doc2 §11, Doc3 §11. |
| G5 | Worker session carries deviceId/stationId | Session table lacks deviceId/stationId columns. Doc1 §1 example payload; Doc2 §9. |
| G6 | Data-driven role classification (multi-role future) | `classifyRole` hard-codes seeded role names; a new operational role (e.g. SORTING_WORKER) would be UNKNOWN → locked out. Doc1 §15, Doc2 §2/§6. |
| G7 | Native Android Worker App (real native, scanner-first) | The previous `mobile/` was removed by order. To be rebuilt as a native app (no WebView) against this backend. Doc3. |
| G8 | Scanner Core / OCR / offline queue / device telemetry | Doc3 P0.4–P0.10 — after backend isolation and native shell exist. |

---

## 2. Files / modules affected (by phase)

- **Backend — auth & surface**: `app.module.ts` (register guard), all worker/admin controllers (decorators), `auth/*` (device+station session binding), `users.service` (revoke on disable), `access/application-access.ts` + `seed.ts` + `schema.prisma` (role class column), `prisma/migrations/*` (new).
- **Backend — devices**: new `modules/devices/*` (model, controller, service, DTOs), admin pages API surface untouched.
- **Backend — security events**: `AuditAction` enum + migration, `audit.service.ts` unchanged, guards log denies.
- **Frontend Admin Web**: workers/devices management screens only — no redesign of existing flows.
- **New native app** (separate Android project under `mobile/`): `scanner-core` module (pure logic), app shell, worker API client, session store, UI per workflow.

## 3. APIs reusable as-is
- `POST /v1/auth/login` (+ `app`), `POST /v1/auth/refresh`, `GET /v1/auth/me`, logout
- `GET /v1/terminal/context`, `/v1/terminal/assignments*`
- `GET/POST /v1/receiving/*` (receiving workflow), `PUT/POST /v1/putaway/*`
- `POST /v1/fulfillment/*` (sorting/packing/shipping worker flows)
- Admin: `/v1/users`, `/v1/roles`, `/v1/permissions`, `/v1/stations`, `/v1/operations`, `/v1/audit`, warehouse tree, categories, expected-arrivals, shipments

## 4. New APIs needed (not yet existing)
1. Worker self profile with station+device: `GET /v1/worker/context` or extend `/auth/me` (worker surface) to include `station`, `deviceId`, `workflow`, `allowedActions`.
2. Device management (admin): `GET/POST/PATCH /v1/devices`, `POST /v1/devices/:id/status`, `POST /v1/devices/:id/assign`, list online/offline + lastSeen (Doc3 §11/§13).
3. Scan/telemetry intake (worker): `POST /v1/scanner/events` (idempotent, offline-sync safe) and admin analytics read API (Doc3 §14).
4. (Phase) session revocation endpoint granular: admin revoke a worker's sessions.

## 5. Native Android technology choice + rationale
| Choice | Reason |
|---|---|
| Kotlin + Jetpack Compose (Material3) | Modern native UI, small APK, fast startup; the old scaffold used the same stack |
| CameraX + ML Kit (`barcode-scanning`, `text-recognition`) | One camera lifecycle; QR + 1D barcode + OCR out of the box; no WebView, no browser APIs |
| OkHttp + kotlinx-serialization | Thin authenticated JSON client to the same Warehouse Core API |
| EncryptedSharedPreferences / Keystore | secure session token storage (Doc3 §12) |
| Room or plain local queue | offline op queue with operationId/deviceId/workerId/stationId/seq + sync dedupe (Doc3 §10) |
| scanner-core pure Kotlin module | shared decision/debounce/normalize logic testable on JVM, one engine for all stations (Doc3 §6, §8) |
| Distribution | internal APK/AAB + managed/internal distribution; debug-signed QA builds are acceptable (user decision: internal only, no Google Play) |

## 6. Migration plan (no breakage of current flows)
1. Backend: additive only. Register ApplicationGuard (opt-in semantics: routes without decorator behave as today), then tag controllers surface by surface — web worker terminal logs in with `app=WORKER_NATIVE` so it keeps working; Admin Web stays `ADMIN_WEB`.
2. Schema additions (Session.deviceId/stationId, Role.applicationClass, Device model, new AuditActions) as new Prisma migrations — deploy via `prisma migrate deploy`.
3. e2e acceptance suites must log in with the explicit `app` field matching the surface under test.
4. Native app phases P0.2→P0.10 land against the same API; the web worker terminal remains functional until the native app replaces it in the field.

## 7. Acceptance tests per phase
- **P0.1 audit** — this document + gap map. ✔
- **P0.1b HTTP surface enforcement (this batch)** — automated: `application.guard.spec.ts` (unit), plus CI `npm run build` + `npm test`; e2e isolation matrix extended to login+HTTP (admin token on worker endpoint → 403; worker token on admin endpoint → 403).
- **P0.3 auth/worker/role/station** — extend e2e: worker logs with device/station claim; station change reflected next context; disabled worker forced re-auth (Test 5); revoked device Test 6.
- **P0.2/P0.4–P0.6 native shell + scanner** — Android instrumented + JVM unit tests for scanner-core debounce/dedupe/normalize.
- **P0.7 receiving integration** — receiving e2e on native API path + duplicate scan prevention.
- **P0.8 offline queue** — JVM tests: queue survives drop, dedupe on sync.
- **P0.9 device mgmt** — backend e2e device CRUD/revoke + admin UI smoke.
- **P0.10 telemetry** — backend e2e scan-events idempotency + admin analytics query.

Definition of Done (Doc1 §17) is tracked per phase above; the two headline rules
(ADMIN→WORKER_APP ❌, WORKER→ADMIN_WEB ❌) are enforced by the backend at
login AND on every decorated route.
