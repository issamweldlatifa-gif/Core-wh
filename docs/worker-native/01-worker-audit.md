# 01 · Worker App audit

Date: 2026-09-05 · baseline: `4b762cfd035c6fcc3b24c55f29fe78e464245dd8`

**Source audit, not production certification.** Repository source, controllers, services, DTOs, Prisma schema/migrations, tests, deployment configuration and earlier reports were inspected before native implementation. Earlier reports describe older revisions and are not acceptance evidence for this revision. No Zebra reference image was attached in this session; the design uses the written industrial-terminal brief, not a purported copy of that image.

## Product boundary and freeze

There is already a real Android app: `mobile/`, application ID **`com.ayrovi.worker`**, Kotlin 2.0.21 / Compose / SDK 35 / minimum Android 26. There is also a React Worker Terminal within the Admin Web deployment. **Do not create another Android project, application ID, production API, or per-role app.**

The web Worker Terminal is the temporary migration reference/fallback. Its source is frozen in this change. The existing native UI is retained as a build-time rollback/reference in the same application, not a second installable application. Neither fallback is certified safe by its existence. The native migration is a Receiving-first pilot; retirement requires the gates in reports 14–19.

## Inventory (baseline, including unsuccessful/unreachable paths)

| Area | Evidence | Actual behavior / assessment |
|---|---|---|
| Web framework | `frontend/package.json`, `src/App.tsx` | React 18, TypeScript, Vite 7, React Router 7; not native. |
| Login and entry | `pages/Login.tsx`, `shell/GlobalShell.tsx` | `/login?app=worker` requests WORKER_NATIVE; default is ADMIN_WEB. `/terminal` is a workspace within the shared web deployment. |
| Routes | `App.tsx` | `/terminal/{receiving,putaway,sorting,order-sorting,packing,shipping}`. `/warehouse/receiving` and `/receiving` redirect to `/terminal/receiving`. No directed-picking, inventory-counting or returns route. |
| Web shell / home | `terminal/{WorkerShell,WorkerTerminalHome}.tsx` | Context, station, status footer, assigned tasks. Resume > assignments > single ready task > task picker. Context/assignment errors can be incorrectly presented as no work. |
| Native navigation | `mobile/app/.../ui/Screens.kt`: `AyroviApp`, `StationTabs`, `StationRouter` | One Activity, in-memory Compose navigation and consumer-like bottom tabs. No ViewModel. API calls and workflow state live in a 1,711-line UI file. |
| Native screens | same file | Login, Home, Receiving, Tote, Sorting, Customer Bin, Packing, Shipping, Trace. `StationKey.fromKey` does **not** implement server key `putaway`. |
| Unreachable native screens | `StationKey`, `TASK_REGISTRY` in `terminal.service.ts` | `receiving-container`, `customer-bin`, `archive-trace` are not registry keys. `order-sorting` maps to Customer Bin; the separate Tote screen has no server-advertised entry. |
| API clients | web `api/client.ts`, `modules/receiving/api.ts`, `terminal/{api,putaway-api,fulfillment-api}.ts`; native `data/WorkerRepository.kt` | Real `/api/v1` endpoints. Existing native client is the reuse point, not a reason to add another API implementation. Native methods for quantity receipts and trace exist even when screens are unreachable. |
| Authentication | `auth.controller.ts`, `auth.service.ts`, `dto/login.dto.ts`, `token.service.ts` | Employee code + password or PIN. Login fields are `identifier`, `secret`, optional `mode`, **`app`**, `deviceId`. Access/refresh JWTs; refresh rotates the DB session. |
| Request security | `jwt.strategy.ts`, `permissions.guard.ts`, `application.guard.ts`, `app.module.ts` | JWT session, active user, live roles/permissions checked on each protected request. Application guard is opt-in. Receiving and Fulfillment are surface-neutral; Terminal and Putaway require WORKER_NATIVE. UI visibility is not enforcement. |
| Role resolution | `access/application-access.ts`, `prisma/seed.ts` | DB role `applicationClass`; legacy name fallback only for UNKNOWN. OPERATIONAL opens native; ADMIN/VIEWER opens admin; mixed classes union. No invented role-name checks in new UI. |
| Device / station | `auth.service.ts`, `devices.service.ts`, `stations.service.ts` | Device registration is admin-only. Presented code must be ACTIVE and bound/unassigned. Worker login without a device code is currently allowed (legacy compatibility). Station captured if exactly one assigned ACTIVE station. Not hardware attestation. |
| Session expiration | `jwt.strategy.ts`, native `WorkerRepository.kt` | Access 401 triggers refresh once. Baseline native refresh is not single-flight; simultaneous 401s may race rotation. Some UI catches never propagate 401 to root. No foreground revalidation loop. |
| Logout / identity | native `SessionStore.kt`, `WorkerRepository.logout` | Logout swallows failures. `clear()` clears preferences **before** reading device code, regenerating identity. This breaks registered-device continuity. |
| Secrets | native `SessionStore.kt` | EncryptedSharedPreferences normally used, **but silently falls back to plaintext** on any Keystore error. Invalid security behavior; must fail closed. Backup disabled. |
| Endpoint / signing | `app/build.gradle.kts`, `.github/workflows/android-build.yml` | HTTPS backend hardcoded as default; release is debug-signed at baseline. CI automatically deletes/replaces rolling canary release after every passing branch build. Not a controlled production cutover. |
| Receiving web | `terminal/ReceivingTask.tsx` | Carton identification then confirmation; product totals or, when tote selected, one `scan-article` call per unit. Partial multi-unit failure can leave an unknown number committed. No actual condition/reject API. |
| Receiving native | `ReceivingStation` in `Screens.kt` | **CARTON_IDENTIFIED is reported as CARTON RECEIVED without calling receive-carton.** Checks `ACTIVE` instead of server `RECEIVING`, hiding pause/complete. No integrated product stage. |
| Tote native | `ToteStation` | Picks first active arrival session found, not necessarily worker's intended session. Local increment is used for article count. No source/operation ID in article receipt. |
| Receiving backend | `receiving.service.ts`, `fulfillment.service.ts` | Expected quantities are immutable. Two receipt paths: totals-only receiving-product vs ArticleUnit/tote path. Reconciliation logic duplicated server-side. These are not interchangeable. |
| Picking | `OrderSortingTask`, `CustomerBinStation`, `fulfillment.service.ts` | Article→customer order→bin exists. **Not directed picking**: no assigned location-first pick task, reservations or quantity confirmation contract. Permission name `picking.execute` does not prove this workflow exists. |
| Putaway | `PutawayTask`, `putaway.service.ts` | Carton-first placement, append-only placement history. Category destination is advisory in carton placement, not enforced. Article sorting enforces a resolved wrong zone, but can accept UNMAPPED/AMBIGUOUS resolution on direct store calls. Requires backend verification before requested strict-location native workflow. |
| Inventory | schema, controller inventory, task registry | `inventory.view/manage` keys exist. No cycle-count/recount/blind-count tasks, count ledger, variance/reason API or terminal. **MISSING**. |
| Returns | same | No return-task, disposition, quarantine/restock/rejection controller or schema workflow. **MISSING**. |
| Other roles | `SortingTask`, `OrderSortingTask`, `PackingTask`, `ShippingTask` + native station functions | Actual backend operations exist; do not retire these during Receiving-only migration. Native packing says “PACK & PRINT LABEL” but invokes no native printer. |
| Barcode source | native `StationScanner` | Camera / Honeywell callback source discarded by generic station binding; Receiving hardcodes EXTERNAL_SCANNER even for manual/camera. Rejected scans silently ignored. |
| Native hardware scanner | `scanner/HoneywellScanner.kt` | Honeywell claim/release and exported broadcast receiver; no Zebra DataWedge adapter. Registration ON_START and removal ON_PAUSE do not form a correct resume pair. Exported decode broadcasts are untrusted input, not authorization. |
| Native camera | `scanner/CameraScanner.kt` | CameraX + bundled ML Kit. Camera failures swallowed; delayed provider callback can run after disposal; no timeout/cancel result contract. OCR disabled in operational UI. |
| Native scanner rules | `scanner-core/{ScanDecision,OcrNormalizer}.kt` | Time debounce and last-code duplicate guard; wall clock; held code can re-fire after window. OCR score is format plausibility, not backend validation. Do not auto-authorize from it. |
| Web scanner | `modules/receiving-terminal/` | Shared ReceivingScanner host; hardware wedge/manual, BarcodeDetector/ZXing, Tesseract + optional PP-OCR/ONNX; quality, ROI, consensus, corpus, dedupe, feedback, telemetry. Source is reusable evidence, **not** a native WebView/JS payload to embed. |
| Validation mismatch | web `validate.ts`, `normalize.ts`, `hardware-scan.ts`; backend service searches | Web often uppercases/strips characters; backend SKU comparison is exact trimmed string. Hardware regex length 4–64 excludes codes backend can accept. No blind substitution/case folding in native business identity. |
| Errors/loading | all station files + `all-exceptions.filter.ts` | API errors are `{statusCode,message:string|string[],error,path,timestamp}`. Business failures may be HTTP 200 `flash.kind` / `kind`. Baseline mixes ERROR text, swallowed errors and local success counters. |
| Network state | web WorkerShell; native AyroviApp | Browser navigator.onLine / native successful boot only. Neither proves ongoing API reachability. No authorized offline writes. |
| Local state/cache | storage search across worker/scanner/client files | Web tokens and scan preferences in localStorage. Task/session state in memory; server session recovery. Native encrypted prefs with insecure fallback; Compose `remember` loses draft on recreation. No Room database, persistent receipt outbox or worker cache. |
| Offline / sync | `scanner-core/OfflineQueue.kt` + usage search | Serializable, in-memory **unused** generic queue. No sync endpoint, durable adapter, replay authorization, or worker-scoped replay integration. Must not be advertised as offline receiving. |
| Notifications | `system/live.controller.ts`, `fulfillment.service.ts` | SSE is an ADMIN_WEB operations feed; no native push or worker notification service. Activity beeps/vibration are local feedback, not notifications from backend. |
| Database | `prisma/schema.prisma`, migrations | Sessions/users/roles/devices/stations, arrivals/shipments/cartons, receiving rows, ArticleUnit/containers, placements, orders, shipments, audit. Counts must use these records, never sample task numbers. |
| Upstream dependencies | `integrations/crm/*`, categories service | Arrivals/shipments/orders arrive via existing integration guards. Native does not connect directly to CRM or database. Carrier adapter is explicitly null/internal-label only. |
| Deployment drift | `main.ts`, `bootstrap-schema-repair.ts`, `start.sh`, `build.sh`, `backend/public/` | Pre-existing schema repair + migrations and tracked built SPA assets; do not rebuild/remove these as incidental Worker cleanup. Verify deployed schema and commit separately. |

## Critical findings / production blockers

- **W-01:** False carton-success and wrong native session status (source-confirmed).
- **W-02:** Plaintext credential fallback and unstable device code on logout (source-confirmed).
- **W-03:** `/receive-product` ignores client `operationId`; `/scan-article` has no idempotency key, bulk quantity, operation lookup or scan-source field. **No blind mutation retries or offline queue.**
- **W-04:** Receiving condition, accept/reject disposition, return/rejection authorization/reasons are **not defined**. Generic flag is not a rejection.
- **W-05:** Shared receiving mutation helper permits PAUSED sessions; article receipt rejects them. Session ownership/warehouse scope is not consistently enforced. Start has a race around one-active-session check; multi-shipment arrival uses first shipment but tally counts all.
- **W-06:** Receiving product arithmetic duplicated across two backend services and read/modify/write counters are vulnerable to concurrent receipts. Container capacity is stored but not enforced by article receipt.
- **W-07:** Strict destination authorization required by requested Putaway is not present in carton placement; direct article store and order-sorting transitions need negative tests.
- **W-08:** No directed Picking, Inventory or Returns contract. No physical device or production pilot evidence for this revision.
- **W-09:** Refresh service verifies JWT but does not compare stored refresh hash; rotation is not an atomic compare-and-swap. Device reassignment is enforced by device service session revocation, but JWT strategy itself only checks device active status. Backend security follow-up required.
- **W-10:** Frontend baseline `npm run typecheck` fails in `admin/pages/LiveBoard.tsx:38` (`AuthContextValue.token` does not exist). Worker scanner baseline: 107 tests pass. Do not hide the unrelated baseline failure.

## Audit disposition

See [02](02-component-matrix.md) for classifications, [03](03-api-contracts.md) for contracts, [04](04-business-logic.md) for extraction and invalid-rule handling. Verified here means **source-verified** unless the test evidence explicitly says executed. No claims that a physical scanner, production API, pilot, or retirement passed.
