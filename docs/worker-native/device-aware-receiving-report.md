# Device-aware Receiving · implementation and acceptance report

Date: 2026-09-06 · starting source `02b3b48` · status: **audit complete; implementation/verification in progress**.

This increment is not accepted merely because it renders. Physical CT40 trigger/firmware, approved live API/DB, station authorization and full warehouse acceptance remain separate gates. Final executed evidence is recorded below after verification.

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

Pending final inventory.

## B. Existing systems reused

WorkerRepository/transport, SessionStore/MutationJournal, WorkerSessionUseCase, ReceivingWorkflow, Honeywell detector + intent adapter, DataWedge adapter, ScannerManager/ScanDecision, CameraX/ML Kit, design tokens, ToneGenerator/haptics and Android CI.

## C. Device detection integration

One existing Honeywell identification owner, refined in place; AppContainer supplies immutable PHONE/CT40 mode. Model/brand/manufacturer detection is a UX hint, not attestation. No screen-width detection or production debug toggle.

## D. Phone UI architecture

Touch/software scan first, shared CameraX engine, secondary camera/manual options, richer details and scrolling. Same state/commands/validation as CT40.

## E. CT40 UI architecture

Distinct scanner-first viewport, compact station header, native lightweight CT40DeviceVisual, large state feedback, hardware trigger primary, manual fallback secondary. No internet device photograph or phone resized into a terminal.

## F. Scanner integration

One scanner session/manager and source pipeline per Receiving ViewModel/lifecycle. Capture events go to the same workflow regardless of presentation. Decode, backend validation and warehouse receipt remain distinct.

## G. Hardware trigger integration

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

Pending execution. Required: detector/fallback cases; shared flow with real HTTP transport tests; scan feedback timers/duplicates/rapid scans; audio dispatch/failure/volume policy; queue zero/positive/unknown counts; both native presentations at narrow viewport, large fonts, theme/navigation; receiving lifecycle and secure recovery regression. CI emulation is not physical hardware acceptance.

## N. Known limitations

No physical CT40, hardware trigger or approved live warehouse API/DB access in this workspace. Current backend does not prove station assignment from its global arrival queue. Sorting/Putaway native availability and full rollout remain gated. No claim of Honeywell/Zebra certification or completed production migration.

## O. Backend changes required

No new endpoint is needed for device-specific presentation. Station/owner-scoped work counts and validation, atomic/idempotent article receipt/result lookup, condition/disposition and full downstream workflows still require the separately approved BC-01…06 work. Frontend styling cannot repair these contracts.
