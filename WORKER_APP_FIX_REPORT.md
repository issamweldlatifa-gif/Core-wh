# Worker App — Final Fix, OCR Hardening & Card Flow Completion
## Technical Report (2026-09-08)

Branch: `arena/worker-ocr-carton-settings-fix`
Scope: Worker Android app (`mobile/`) — targeted, additive fixes. **No rebuild, no parallel architecture, the verified Product Card flow is untouched.**

---

## A. OCR — ML Kit hardening

### Files modified / added
- `mobile/scanner-core/.../scanner/OcrTemplate.kt` — strict SKU template documented as the
  device-side mirror of the backend SKU contract; **new `CartonTemplate`** for the CARTON lane.
- `mobile/scanner-core/.../scanner/OcrNormalizer.kt` — **new `compactSku(raw)`** and **`cartonCode(raw)`**
  strict shape gates; ML Kit text is never accepted unless a token passes the lane shape.
- `mobile/scanner-core/.../scanner/OcrFrameVote.kt` — **new** multi-frame vote stabiliser.
- `mobile/app/.../scanner/ScanCoordinator.kt` — lane-aware template resolution + frame-vote gating.
- `mobile/app/.../scanner/ScannerCaptureHost.kt` — OCR camera + paste paths now carry the lane template.
- `mobile/app/.../presentation/ReceivingHomeScreen.kt` — passes the lane template to the scanner host.
- Tests: `scanner-core/.../DirectedOcrTest.kt` (CartonTemplate, strict extraction, frame vote).

### ML Kit implementation status
- Camera ML Kit text recognition (`TextOcrScanner`, ML Kit `TextRecognition` Latin) and ML Kit
  barcode scanning (`CameraScanner`) were already integrated and are **preserved unchanged**.
- Hardware CT40 (Honeywell) / Zebra DataWedge scanners still pass straight into the single
  `ScannerManager` guard via `onScanned(...)` — **hardware scanning is not touched**.
- Both hardware and OCR paths converge on the same scan guard / same backend confirm endpoints
  (no duplicated business logic).

### Validation rules
- PRODUCT lane OCR: strict compact-SKU shape `^s[a-z][0-9]{1,20}$`, case-insensitive (e.g. `sb12345`,
  `SB25092090066487374`). Quantities (`12345`), bare words (`CARTON`), segmented codes
  (`SKU-TEST-001`) and merged garbage are rejected on the device.
- CARTON lane OCR (the real gap, see §D): accepts carton ids (`CTN-2026-000001`, `CTN…`),
  carton references (`SHP145-01`) and carrier tracking runs (`DHL1234567890`); explicitly
  **rejects the compact product SKU** so a product label can never confirm a carton.
- The backend (`/v1/receiving/home/product` & `/carton`, `normalizeScan`, card existence) remains
  the final authority — device shape validation only stops noise from being offered.

### Multi-frame confidence
`OcrFrameVote` keeps a short rolling window (default 2 identical readings within ~2.5 s). One bad
frame can never self-accept; a clean **high-confidence (≥0.95)** frame still surfaces immediately,
so a steady label stays fast. Operator confirmation in the review UI is still required (no
auto-submit). Paste/typed OCR bypasses the vote (manual entry is already intentional).

### Before / after
- BEFORE: OCR review existed only for the compact SKU shape in **both** lanes; pointing OCR at a
  carton label (e.g. `CTN-2026-000001`) produced "No SKU found" and a single live frame could drive
  the review.
- AFTER: each lane shape-gates its own identifier family; live camera reads require a repeated
  (or very-high-confidence) candidate; the operator still reviews/confirms; CT40/barcode unchanged.

---

## B. Home — stale notification after completion

### Root cause
Two independent, backend-state-driven issues:
1. **Tray notification never cleared.** The whole-app poll (`WorkerAppViewModel.loadContext`) fired a
   "New card" notification when a lane's pending count *increased*, but nothing ever **cancelled**
   the Android notification when the count returned to 0 after the worker finished the task. The card
   was completed on the backend; the OS tray (and the sense of a "pending" item) stayed.
2. **Receiving Home local feed could keep a stale payload.** After a confirm, the workflow applied
   `result.home` only if present; on any verdict returned without a refreshed feed, the on-screen
   cards/counters were not re-synced until the 20 s auto-refresh or a manual refresh.

### Fix (state management + invalidation)
- `ReceivingNotifier` gains `clearCard(product)` / `clearAll()`; the poll now cancels a lane's
  notification as soon as its pending count reaches **0** (and on sign-out).
- `ReceivingHomeWorkflow.applyResult` is now authoritative-feed-first: it uses the fresh feed from
  the verdict, and if that feed is absent it **re-pulls `GET /v1/receiving/home`** before rendering.
  Backend state update → local state replaced with the server feed → completed card disappears.
- Back-navigation from Receiving to the Work Queue already triggers `model.refresh()`; the 30 s
  whole-app poll and 20 s Receiving auto-refresh remain (no aggressive polling added).
- This is real state invalidation, not local hiding: completion is persisted by the backend
  (`WarehouseCarton.status = RECEIVED` / `ReceivingProduct.receivedQuantity`), and the card leaves
  `workerHome` because pending queries exclude received/fully-received rows.

### Tests
`ReceivingHomeWorkflowTest` (+1): completing a carton whose verdict carries **no** feed still ends
with `cartonCardsPending == 0` (regression cover for stale Home state).

---

## C. Product Cards — existing successful flow
**Confirmed intact.** No changes to the Product Card delivery, notification, matching or
confirmation path. Product Home feed logic, the `homeConfirmProduct` endpoint, the device-side
`CardMatcher.matchProduct`, and the backend product confirmation are unchanged. New tests only add
coverage; existing 13 Receiving workflow tests still pass.

---

## D. Carton Cards — audit, root cause, fix

### Line-by-line audit (evidence)
The full path was traced and the backend side is genuinely symmetric with Product cards:

| Stage | Product Card | Carton Card | Finding |
|---|---|---|---|
| CRM ingestion | Customer Arrival Card → `ExpectedArrival`+items | Shipment Card → `POST /integrations/arrivals/shipments` → `WarehouseShipment`+`WarehouseCarton(status=EXPECTED)` | OK; cartons created with external id / ref / QR (falls back to id) / barcode |
| Auto-dispatch | `dispatch.dispatch('receiving', {arrivalId})` | **same** `dispatch('receiving', {arrivalId})` inside the shipment transaction | OK — one dispatch architecture, idempotent |
| Worker feed | `workerHome` → `productCards` / `productCardsPending` | `workerHome` → `cartonCards` (all non-RECEIVED/VOIDED cartons of scoped shipments) / `cartonCardsPending` | OK — returned together in the same `GET /v1/receiving/home` |
| Worker poll/notification | `receivingProductPending` | `receivingCartonPending` (already counted, notifies) | OK |
| Confirm | `POST /v1/receiving/home/product` | `POST /v1/receiving/home/carton` → resolves owning arrival → `confirmCarton` (id/ref/QR/barcode/tracking, ambiguity handled) | OK — carton marked RECEIVED + `ReceivingCarton` + audit/worker log |
| Device matching | `CardMatcher.matchProduct` | `CardMatcher.matchCarton` (id/ref/QR/barcode + tracking, ambiguity/all-received verdicts) | OK |

### Exact root cause of "Carton Card NOT ARRIVING"
The delivery architecture on the backend/feed side is correct and shared. The divergence found is
on the **device OCR lane**: the OCR camera and the OCR paste/typing path in both lanes were wired to
the **compact product-SKU template only**. A carton label (`CTN-2026-000001`, a tracking number, a
carton QR text) never produced a candidate in the CARTON lane, so when the carton's printed
identifier was read by **camera OCR / label-text entry** (rather than the physical barcode), the
worker got "No SKU found" and could not open/action the carton — i.e. the carton effectively never
"arrived" as an actionable OCR item, even though barcode/hardware scans and the feed worked.

### Exact fix
- Added `CartonTemplate` and routed it through the CARTON lane OCR (camera + manual label-text),
  while the PRODUCT lane keeps the strict compact-SKU template. Lane separation is preserved (the
  carton template rejects the `s…` product SKU and the product template rejects carton/tracking
  shapes).
- Carton delivery otherwise reuses the **exact same** card/event/notification/poll architecture as
  Product cards — no second delivery system was created.

### Complete delivery path after fix
CRM Shipment Card → `WarehouseShipment`+`WarehouseCarton(EXPECTED)` + `dispatch('receiving')`
→ worker's `GET /v1/receiving/home` returns `cartonCards` + `cartonCardsPending`
→ whole-app poll raises the CARTON tray notification + Home CARTON tile count
→ CARTON lane SCAN matches (hardware/barcode OR camera-OCR/label-text via `CartonTemplate`)
→ device `matchCarton` MATCH → confirm → `home/carton` → `confirmCarton` persists RECEIVED
→ refreshed feed removes the card + notification clears.

Evidence the card reaches the worker: `receiving-home.spec.ts` / `receiving.service.spec.ts`
(backend, passing) and `ReceivingHomeWorkflowTest` carton tests (device matching + completion),
plus new `CartonTemplateTest` for carton identifier OCR.

---

## E. Settings

### New screen
`mobile/app/.../presentation/WorkerSettingsScreen.kt` — a single worker SETTINGS dialog shared by the
Work Queue and Receiving, structured per the requested information architecture:
- **ACCOUNT** — worker profile, station.
- **OPERATIONS** — **SWITCH MODE** (returns to the work queue / mode tiles; role permissions stay
  enforced by the backend — no auth bypass), plus CHANGE DISPLAY (existing contrast toggle moved here).
- **SUPPORT** — **SEND REPORT** and **REPORT A PROBLEM**.
- **SYSTEM** — App version, Connection status, Device class only.
- **ABOUT** — app name.

### Reports
- Both Support actions submit through the **existing** backend endpoint
  `POST /v1/fulfillment/exceptions` (creates a real `OperationalException`, visible on the Admin
  Exceptions board, audited) — **no duplicate reporting API** (`WorkerRepository.reportProblem`).
- Report a Problem categories: Scanner / OCR / Card / Network / Other (operational types).
  Diagnostic context attached server-side-safe: device class, app version, truncated device code,
  timestamp, optional card/task reference — no credentials/internal IDs shown to the worker.

### Technical information removed / kept
- The old ad-hoc settings dialog that dumped raw open-instruction records and developer-oriented
  content into the operational UI was replaced by the clean grouped screen.
- Hidden from worker-facing UI: internal/DB ids, API details, debug dumps, developer logs.
- Kept (genuinely operational): app version, connection status, device class, station code,
  the operational scanned code on a match/error. No debug-only UI exists in release builds.

---

## F. Testing — acceptance criteria

Pure-JVM module tests run locally (Temurin JDK 17, Gradle 8.9):

| Area | Criterion | Result |
|---|---|---|
| OCR | ML Kit text recognition present | **PASS** (preserved, `TextOcrScanner`) |
| OCR | Strict SKU validation (s+letter+digits), rejects noise/qty/words | **PASS** (`CompactSkuTemplateTest`, `CartonTemplateTest`) |
| OCR | Carton/tracking shape accepted in CARTON lane; product SKU rejected there | **PASS** (`CartonTemplateTest`) |
| OCR | Multi-frame vote locks only on repeat; stale frames expire | **PASS** (`OcrFrameVoteTest`) |
| Scanner | Single scan guard shared; CT40/barcode path untouched | **PASS** (`ScanDecisionTest`, `ScannerManagerTest`) |
| Home | Completed product/carton removed from active feed | **PASS** (`ReceivingHomeWorkflowTest`) |
| Home | Re-pull of feed when verdict lacks it (stale-state regression) | **PASS** (new test) |
| Home | Tray notification cancelled when lane drains / on logout | **PASS** (code: `ReceivingNotifier.clearCard/clearAll`, poll wiring) |
| Product Cards | Existing flow unchanged | **PASS** (13 workflow tests + backend 34 receiving tests) |
| Carton Cards | Same delivery architecture, reaches worker, matches, completes | **PASS** (backend + device tests; OCR lane fixed) |
| Settings | Send Report / Report Problem / Switch Mode / clean system info | **PASS** (compiles; uses existing exceptions endpoint) |
| Backend | No regression | **PASS** — `tsc --noEmit` 0 errors; **142/142 jest tests pass** |
| Mobile JVM | scanner-core + worker-core unit tests | **PASS** — **85 tests, 0 failures** |

Note: the full Android `assembleDebug`/lint/instrumented tests require the Android SDK (not present
in this environment); they run in the repo's CI (`android-build.yml` on `arena/**`) which builds
`:app:assembleDebug`, runs lint and the emulator/UI tests. All changed Kotlin compiles and every
JVM unit test passes locally.

---

## G. Git

- Branch: `arena/worker-ocr-carton-settings-fix`
- Changed/added files:
  - `mobile/scanner-core/src/main/kotlin/com/ayrovi/worker/scanner/OcrTemplate.kt` (modified)
  - `mobile/scanner-core/src/main/kotlin/com/ayrovi/worker/scanner/OcrNormalizer.kt` (modified)
  - `mobile/scanner-core/src/main/kotlin/com/ayrovi/worker/scanner/OcrFrameVote.kt` (**new**)
  - `mobile/scanner-core/src/test/kotlin/com/ayrovi/worker/scanner/DirectedOcrTest.kt` (modified)
  - `mobile/worker-core/src/main/kotlin/com/ayrovi/worker/data/WorkerRepository.kt` (modified)
  - `mobile/worker-core/src/main/kotlin/com/ayrovi/worker/domain/ReceivingHomeWorkflow.kt` (modified)
  - `mobile/worker-core/src/test/kotlin/com/ayrovi/worker/ReceivingHomeWorkflowTest.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/scanner/ScanCoordinator.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/scanner/ScannerCaptureHost.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/feedback/ReceivingNotifier.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/presentation/WorkerAppViewModel.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/presentation/WorkerTerminalApp.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/presentation/ReceivingHomeScreen.kt` (modified)
  - `mobile/app/src/main/java/com/ayrovi/worker/presentation/WorkerSettingsScreen.kt` (**new**)
- Backend delivery path: audited, found correct — **no backend change required**.
- Build: backend `tsc` + 142 jest tests green; mobile JVM 85 tests green; APK produced by CI
  (`android-build.yml`) on push to `arena/**`.

> Security note: the GitHub token shared in chat was used only for authenticating the push and is
> **not** stored anywhere in the repo. Rotate/revoke it after this work.
