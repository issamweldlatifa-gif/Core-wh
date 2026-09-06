# Device-aware Receiving · implementation and acceptance report

Date: 2026-09-06 · starting source `02b3b48` · status: **implemented and CI-verified; physical/live warehouse acceptance pending**.

This increment is not accepted merely because it renders. Physical CT40 trigger/firmware, approved live API/DB, station authorization and full warehouse acceptance remain separate gates. Final executed evidence is recorded below; no production cutover or physical-hardware certification is claimed.

## Current build / تجربة النسخة

**AYROVI Worker 1.5.0-pilot**, same application ID `com.ayrovi.worker`.

- [Download the QA APK artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981821576) (ZIP containing `app-debug.apk`).
- [Native screenshots and emulator results](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981898482) — **10 screenshots**, visibly marked test fixtures, not warehouse data.
- [Successful complete CI run](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849) · native source `c657be7d9572c66b2e24b7660779099b5d6a52c6`.
- **123 JVM tests + 19 Android instrumentation tests passed**, zero failures/skips; APK build and lint passed.

Use an approved test device/backend. Do not clear operational data to bypass an update-signature error. Test the actual CT40 trigger, firmware profile, sound and stock reconciliation before warehouse acceptance.

## Pre-change audit (before implementation)

| Concern | Existing owner / finding | Decision |
|---|---|---|
| Device identification | `scanner/HoneywellScanner.isHoneywellDevice()` reads manufacturer/brand; `ZebraDataWedgeScanner.isZebraDevice()` handles Zebra. No existing native PHONE/CT40 presentation switch. Web `scan-source.ts` classifies browser phone/tablet, not CT40. | Reuse/refine the Honeywell detector in place with model discrimination; expose one result through AppContainer. No width/UA/duplicate detector in UI. Uncertain model → PHONE. |
| Receiving state | `worker-core/domain/ReceivingWorkflow.kt`, one StateFlow, durable MutationJournal, separate preview/source carton and explicit one-unit confirmation/acknowledgement. | Keep one workflow for both presentations. UI feedback phases are not backend lifecycle states. |
| Scanner | Shared ScannerService/ScanCoordinator/ScannerManager; Honeywell claim/release and Data Collection barcode broadcasts; CameraX/ML Kit; DataWedge; manual fallback. | Keep the real hardware path primary on CT40. Refactor the existing scanner host into reusable session/capture controls; no second decoder. |
| Audio | `ui/FeedbackSounds.kt` owns ToneGenerator/haptics, but warning/error use blocking sleeps; new Receiving directly calls success only. | Refactor this implementation to centralized non-blocking AudioFeedback. One shared feedback controller decides outcome sounds; no per-screen audio. |
| Header/navigation | Large common header, same touch layout everywhere, huge queue panels, technical migration copy. | Replace active Worker header/queue and Receiving renderer with explicit Phone/CT40 presentation components. |
| Icons | Unicode/emoji/hand-drawn status glyphs; no installed unified icon family. | Bundle a small licensed subset of Material Outlined vectors behind one semantic icon API. No heavy image/icon library or vendor photo. |
| Competing Receiving | Frozen `Screens.kt` still includes ReceivingStation and ToteStation with their own orchestration. | Remove these native Receiving implementations/routes, keep the shared core only. Preserve other frozen operations and shared backend/Admin until their retirement gates. |
| Errors | OperationalMessage passes some raw API reasons; core/UI copy mentions backend/API/migration/replay. | Central worker-safe message projection, concise business reasons and expected/scanned context. Keep technical diagnosis/contracts in reports, not Worker screens. |
| Offline/auth | HTTPS/versioned transport, one-shot write bodies, CAS login/refresh, secure local logout, stop marker/confirmed receipt acknowledgement. | Preserve all safeguards; transient error feedback must never clear uncertain work or grant offline authorization. |

## Authoritative lifecycle/API map

- Queue: GET `/api/v1/receiving/arrivals`, `receiving.view`. EXPECTED/RECEIVING/PAUSED arrivals; **global available arrivals, not a station-assigned count**. Do not label it assigned or fabricate station rejection. Zero is a real empty queue; network failure is not zero.
- Work context/identity: GET `/auth/me`, `/terminal/context`, `/terminal/assignments`; native surface, live backend permissions. `readyTaskCount` is module count, not work count. Assignment DONE is not stock completion.
- Arrival: GET `/receiving/arrivals/:code/active`, then existing POST `/start` when none. Valid arrival advances to the next existing interaction step. Session status is RECEIVING, not ACTIVE.
- Carton: POST `/scan-carton` identifies only; POST `/receive-carton` records physical receipt. Duplicate/unknown/wrong shipment are distinct. A successful decode must not be called a received carton.
- Tote/product: GET `/fulfillment/containers/:code`; ACTIVE RECEIVING tote required. Fresh session read supplies product preview. POST `/fulfillment/receiving/sessions/:id/scan-article` creates **one** ArticleUnit; no quantity/idempotency/condition/reject fields are invented.
- Exceptions: existing `/flag` and discrepancy `/resolve`, with actual permissions. Generic exception reporting is not formal rejection or quarantine.
- Pause/resume/complete: existing Receiving endpoints. Variance completion requires discrepancy-resolution permission. Cancelled is not successful completion.
- Unknown mutation outcome remains a persistent hold. A known receipt remains until explicit physical acknowledgement. Neither can be dismissed by an error animation, device mode change or scanner reset.
- Missing source scope/atomicity, station/owner assignment enforcement, formal condition/disposition and missing other workflow/count contracts remain BC-01…06 in report03. No backend change is silently included.

## A. Files/components changed

- Existing `scanner/HoneywellScanner.kt`: same detector, CT40 model refinement, empty-input delivery and testable vendor gate. `ScannerService.kt` and `ScannerManager.kt`: availability/capture/rejection event integration.
- `ScannerCaptureHost.kt` **replaces** `TerminalScanInput.kt`; existing CameraX/ML Kit/DataWedge implementations are reused.
- `ReceivingScreen.kt` is the one route and shared dialogs/lifecycle host; `phone/PhoneReceiving.kt`, `ct40/CT40Receiving.kt`, `ct40/CT40DeviceVisual.kt`, `ReceivingParts.kt` are presentation-only.
- `ReceivingViewModel.kt`, `ReceivingFeedback.kt`, `ReceivingSignal.kt`: shared intents, feedback/timers and foreground audio/capture gating. Existing `ReceivingWorkflow.kt` remains the sole business flow.
- `WorkQueueScreen.kt`, `WorkerQueuePolicy.kt`, existing session/ViewModel/access files: compact permitted workflow tiles and real-count badges; unsupported modules disabled with worker wording.
- Existing `FeedbackSounds.kt` becomes a compatibility delegate for non-Receiving frozen screens; its implementation is refactored to `feedback/AndroidAudioFeedback.kt` and shared `AudioFeedback`/`AudioPolicy` ports. No blocking sleep.
- `TerminalComponents.kt`, `TerminalTheme.kt`, `TerminalIcons.kt`, 23 licensed small Material Outlined vectors and provenance/license files: compact headers, indicators, tiles and industrial palette.
- `ui/Screens.kt`: obsolete native Receiving/Tote functions and routes removed. Unused native totals-only repository method removed; server endpoint/web consumers preserved.
- `MainActivity.kt`, `AppContainer.kt`, display preferences: detected presentation and default industrial theme injection, worker-safe startup messages.
- JVM/instrumentation tests, native CI screenshot collection and this report/dossier. No backend/frontend source or schema changes.

## B. Existing systems reused

WorkerRepository/transport, SessionStore/MutationJournal, WorkerSessionUseCase, ReceivingWorkflow, Honeywell detector + intent adapter, DataWedge adapter, ScannerManager/ScanDecision, CameraX/ML Kit, design tokens, ToneGenerator/haptics and Android CI.

## C. Device detection integration

One existing Honeywell identification owner, refined in place; AppContainer supplies immutable PHONE/CT40 mode. Model/brand/manufacturer detection is a UX hint, not attestation. No screen-width detection or production debug toggle.

## D. Phone UI architecture

`PhoneReceiving` is a touch-first renderer of `ReceivingPresentation`. Primary SOFTWARE SCAN uses the existing CameraX/ML Kit engine (or an existing supported external software trigger); USE CAMERA is secondary and manual code is tertiary. These are capture choices, not independent validation engines. Phone may scroll product/quantity/context details; the compact identity header, mode bar and footer remain predictable. It sends only `ReceivingIntent` values to the common ViewModel.

## E. CT40 UI architecture

`CT40Receiving` is a distinct scanner-first renderer, selected from the existing detector result, not screen size. Compact AYROVI/connection + RECEIVING/station header; identity/details remain in settings. The native `CT40DeviceVisual` draws rugged bumpers, imager window and side-trigger pads and changes its shared Material/status indication. READY uses neutral white on the industrial palette; SUCCESS green, ERROR red, WARNING/OFFLINE amber/red. Only active scanning/validation animates the lightweight scan line. No internet device photo, SVG library or phone page shrunk with media queries.

Normal CT40 scanning has no software-scan/camera button. The physical trigger drives the existing Honeywell adapter. Manual code is secondary; camera is an explicit task-menu fallback. Errors/success feedback replace themselves without delaying the next permitted hardware scan. Long review content or accessibility fonts may scroll, but the primary status and fixed navigation remain visible; responsive fitting occurs **inside** CT40 mode only.

## F. Scanner integration

One scanner session/manager and source pipeline per Receiving ViewModel/lifecycle. Capture events go to the same workflow regardless of presentation. Decode, backend validation and warehouse receipt remain distinct.

## G. Hardware trigger integration

Do not use app software scanning to simulate a physical side trigger. Hardware decoder beeps/Scan Wedge notification settings must be checked in the managed Honeywell profile: the app's sound represents **validated workflow results**, whereas an OEM decode beep may only mean a barcode was read. Configure/verify them on the target firmware to avoid conflicting double feedback; no undocumented notification property is invented here.

Existing Honeywell Data Collection Intent API claim/release/receiver remains the real imager path. The API integration currently provides decoded barcode events, not a certified hardware trigger-down/claim-ack signal. Do not invent such broadcasts or claim a button simulation is a trigger test. Readiness labels describe the foreground capture task; actual imager operation requires physical confirmation.

## H. Audio feedback

Central service reusing native ToneGenerator and optional haptics, short distinct outcomes, no sleep on the UI thread, respects volume/ringer/DND/settings and survives unavailable audio. Visual output never depends on audio success.

## I. Receiving state machine

One business state machine; a shared presentation feedback controller derives READY/SCANNING/VALIDATING/SUCCESS/ERROR/WARNING/WAITING/OFFLINE. Transient simple scan errors return to readiness without acknowledgement or a new request. Blocking errors/uncertain writes remain blocked. Required physical confirmations are retained.

## J. Backend/API mapping

See authoritative map above and report03. Only real queue counts; unavailable Sorting/Putaway are disabled/hidden according to existing permissions, without technical migration copy or fake badges.

## K. Error handling

Network, business, auth and uncertain-result categories remain distinct. Worker-safe wording plus meaningful expected/scanned codes. No raw HTTP/Prisma/stack/permission-key strings on operational screens.

## L. Offline handling

No receiving writes, replay, or invented offline authorization. Offline/connection checking is visible in both modes. Confirmed and uncertain receipts keep their existing durable safeguards.

## M. Test results

Executed verification:

- Run34007761925: **101 core + 20 scanner JVM tests passed**; native compile exposed old-screen operator-import and cross-module nullable-count issues, corrected.
- Run34007946855: core/scanner passed; instrumented test compilation exposed an unavailable assertion API. Replaced with measured header bounds. Kotlin warnings are now annotated as warnings, not falsely classified as errors.
- [Run34008165061](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008165061), source `3162865`: **103 core + 20 scanner = 123 JVM tests passed**, APK/lint/test-APK build passed; **18 Android tests passed**, zero failures/skips. **Nine native fixture screenshots** collected and uploaded. Final empty-state/large-text source `c657be7` passed in [run34008673849](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849): **123 JVM tests + 19 Android tests**, zero failures/skips; APK/lint/test APK passed and **10 fixture screenshots** were collected.

| Category | Executed evidence | Remaining |
|---|---|---|
| Device detection | Parameterized existing detector: CT40/CT40XP/Dolphin variants, other Honeywell devices, unknown/null/mismatched brand → PHONE | Actual managed CT40 model/build values |
| Two presentations | Same narrow emulator viewport renders PHONE touch actions versus CT40 visual/trigger-first layout; no phone scan CTA on CT40 | Physical readability/gloves/glare |
| Workflow/HTTP | Full scan→arrival→carton identification/confirmation→tote→product→receipt acknowledgement→completion through production repository/HTTP transport against a local contract test server | Real AYROVI backend/DB deployment and stock reconciliation |
| Hardware integration | Synthetic broadcast exercises existing Honeywell receiver → coordinator → shared VM/workflow; invalid→red/error audio port→automatic ready; valid→green/success port→next step; explicit stock confirmations | Physical side trigger/imager/firmware; no claim that an emulator has CT40 hardware |
| Audio | Central output port dispatch, exceptions cannot block progress, duplicate feedback throttled, background no replay; volume/mute/ringer/DND policy tests | Audible/haptic testing on device, OEM decoder-beep profile |
| Connectivity/authorization | Online/offline/reconnect, late responses, no automatic write replay, timeout/HTTP503 protections, unconfirmed/acknowledgement holds; business station-refusal text separate from connectivity | Actual backend station/owner policy (current source lacks this enforcement) |
| Queue | Zero/one/multiple/unknown counts, no zero badge, unavailable/unauthorized entries, compact grid and navigation callbacks | Live assignment/count updates for downstream workflows |
| Cleanup/security | No second native Receiving/Tote workflow, no device detector in presentation, no per-screen production audio calls, no Worker migration/API/debug text; auth/secure storage regression retained | Full downstream migration and approved retirement |

Emulator fixtures are clearly marked test data. APK/test artifacts are QA outputs. Artifact CDN downloads to this sandbox fail EOF; no local APK installation or manual screenshot review is claimed. No production release or live warehouse mutations were performed.

## N. Known limitations

No physical CT40, hardware trigger or approved live warehouse API/DB access in this workspace. The current intent adapter does not expose a verified trigger-down/claim-ack event: the UI moves to VALIDATING on an actual decoded event rather than fabricating trigger activation. Verified OEM SDK/trigger-event integration may extend the same adapter after target firmware testing. Current backend does not prove station assignment from its global arrival queue. Sorting/Putaway native availability and full rollout remain gated. No claim of Honeywell/Zebra certification or completed production migration.

## O. Backend changes required

No new endpoint is needed for device-specific presentation. Station/owner-scoped work counts and validation, atomic/idempotent article receipt/result lookup, condition/disposition and full downstream workflows still require the separately approved BC-01…06 work. Frontend styling cannot repair these contracts.

## Acceptance decision

**Software implementation and CI verification delivered; production/physical acceptance NOT declared.** The tests exercise real native Compose, the existing Honeywell broadcast adapter with synthetic intents, one shared state machine, and production repository/HTTP code against a contract test server. They do not prove a physical scanner, acoustic behavior, live AYROVI database effects, station-scoped authorization or fleet rollout. Backend and frontend source/schema remain unchanged; required BC-01…06 work and the physical matrix stay open.
