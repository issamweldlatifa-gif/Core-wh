# 02 · KEEP / REFACTOR / REBUILD / REMOVE / MISSING matrix

Baseline and freeze scope: [01](01-worker-audit.md). REMOVE means **after its gate**, not permission to delete the fallback now.

| Component / important responsibility | Classification | Migration disposition / deletion gate |
|---|---|---|
| `mobile/`, Gradle wrapper, application ID, single MainActivity | KEEP | Evolve the existing app; no new application ID or WebView. |
| `frontend/src/terminal` routes, screens and styles | KEEP → REMOVE | Freeze as temporary legacy fallback. Remove only after all retirement gates. |
| Web Receiving scanner/OCR/ONNX assets | KEEP → REMOVE | Retain while fallback needs them; inspect Admin imports before dependency/asset removal. Do not ship JavaScript scanner in Android. |
| Existing native `ui/Screens.kt` | PARTIAL REMOVE | Obsolete ReceivingStation/ToteStation and their native routes removed in the device-aware update to eliminate competing Receiving logic. Non-Receiving compatibility screens stay frozen in the same app ID until their own migration gates. |
| Native API DTOs | REFACTOR | Move to shared JVM core, retain one serialization definition per existing contract. Tighten fields incrementally with contract tests. |
| `WorkerRepository` endpoint methods | REFACTOR | Keep one client; inject transport/session store/base URL, close responses, safe refresh, no auto mutation retry. Do not copy endpoints into ViewModels. |
| Backend controllers and Prisma | KEEP | Source of truth. No silent contract/schema changes in native slice. Required changes tracked separately in API report. |
| Receiving product arithmetic in two backend services | REFACTOR | **Backend change BC-02**, not a third native implementation. Lock/atomic receipt plan and parity tests required before production. |
| Native auth/UI session handling | REBUILD | ViewModel + StateFlow; foreground revalidation; clear session consistently on final 401; permissions from backend only. |
| Encrypted session storage | REFACTOR | Remove plaintext fallback, atomic token pair writes, stable device identity, no secret logging/backups. Fail closed on Keystore failure. |
| Refresh concurrency | REFACTOR | One refresh in flight in shared transport. Backend hash/CAS repair separately BC-05. |
| Native login / home / terminal shell | REBUILD | Operational work queue and fixed task-first shell; no decorative dashboard or consumer tabs. |
| Native Receiving + Tote UI | REBUILD | One guided Receiving lane, scan→identify→confirm carton→tote→product→server result→next. Legacy web/native retained for controlled rollback. |
| `ScanCoordinator` / `ScanDecision` | REFACTOR | Single source-aware manager, bounded input, explicit states, monotonic timing, duplicate feedback. No workflow-local scanner engines. |
| Honeywell claim/release adapter | REFACTOR | Reuse adapter, lifecycle RESUME/PAUSE, exact action filtering, untrusted-input boundary. Hardware claims require physical tests. |
| CameraX + bundled ML Kit barcode | KEEP / REFACTOR | One adapter, permission failure/unavailable handling, lifecycle cleanup; manual fallback remains. |
| Native OCR auto-accept | REMOVE (from live path) | Format plausibility is not product validation. Retain frozen reference normalizer/tests until OCR policy and device evidence exist. |
| Zebra DataWedge adapter | MISSING → REBUILD | One intent adapter to shared manager, managed profile/setup contract. No Zebra assets. |
| Scanner timeout / cancel / unavailable state | MISSING → REBUILD | Shared scanner state, no fake successful scan. |
| Generic unused `OfflineQueue` | KEEP → REMOVE | Frozen reference only; not wired to production. Replaced conceptually by explicit offline policy, not by an unauthorized outbox. |
| Operational error model | REBUILD | Preserve actual backend reason, expected/scanned context, safe retry/reconcile distinction, permission-gated exception actions. |
| Centralized design system | MISSING → REBUILD | Tokens + semantic reusable Compose components, shared by migrated routes. Non-migrated UI is explicitly exempt only during migration. |
| Role-name frontend branching | REMOVE (new path) | Server task keys + permissions; role names for display only. |
| Existing Sorting / Order Sorting / Packing / Shipping | KEEP | Frozen native/web functionality. Do not redesign these before Receiving hardware gate. Never call Order Sorting “directed Picking”. |
| Carton Putaway native | MISSING | Server task currently unmapped. Specification first; strict location backend gap blocks native migration. |
| Directed Picking | MISSING | Backend tasks/reservations/location/product confirmation required. No mock route. |
| Inventory counts / blind count / variance / recount | MISSING | Schema, permissions and API required. `inventory.view` alone is not authorization to count. |
| Returns / condition / disposition | MISSING | Backend policy/API required. No invented reject/restock/quarantine behavior. |
| Receiving formal rejection / condition | MISSING | Generic flag is only an exception; no false rejection confirmation. |
| Worker push / notifications | MISSING | Do not reuse admin SSE or leak bearer tokens in URLs. Foreground refresh is explicitly not push. |
| Bulk article receipt + idempotency lookup | MISSING | BC-01; no partial client-side POST loop or auto-replay. |
| Server task counts for all workflows | MISSING | Receiving can use real arrival list; do not relabel registry count as task count. |
| Physical hardware QA / managed scanner profile | MISSING | [16](16-hardware-test-report.md), required before enabling later migration phases. |
| Release signing / controlled rollout | REFACTOR | No debug-signed production release; artifacts only by default, explicit pilot/cutover. |
| Old assets / obsolete state / libraries | REMOVE after gate | [19](19-cleanup-report.md); do not touch shared Admin or backend features without usage proof. |
