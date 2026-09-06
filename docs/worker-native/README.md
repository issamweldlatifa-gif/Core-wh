# AYROVI Worker · Native Android migration dossier

**v1.5.0 device-aware Receiving:** PHONE touch-first and CT40 scanner-first, automatically selected by the existing Honeywell device identification. One shared business workflow. Full production migration/physical warehouse acceptance is NOT COMPLETE.

The existing Kotlin/Compose app in `mobile/` has been evolved for this pilot—not replaced by another app or a WebView. Application ID remains **`com.ayrovi.worker`**. The backend and shared Admin/web source are unchanged. Legacy Worker UI is frozen and retained behind explicit retirement gates.

## Implemented in this slice

- Shared `worker-core`, existing `scanner-core` and centralized `design-system` modules.
- ViewModels + Android-independent session/Receiving use cases, StateFlow, constructor DI and one real API repository/transport.
- Keystore-backed session/device/recovery storage; no plaintext credential fallback; safe token rotation/logout identity checks.
- Server-authorized work queue with actual Receiving arrival count—not the module readiness count.
- One source-aware camera/Honeywell/DataWedge/manual scan pipeline, lifecycle/duplicate/cancel/timeout/unavailable handling.
- Guided Receiving: actual arrival → identify/confirm carton → validate tote → product review → **one article per explicit confirmation** → server result → next unit → authorized completion/pause/exception actions.
- Durable unresolved-write stop marker and confirmed receipt evidence retained until explicit worker acknowledgement. No offline replay, optimistic stock counter or N-request bulk receipt loop.
- Controlled CI test/report/APK artifacts. No automatic canary publication, deployment or production signing.

## Still blocking production acceptance

BC-01…06 backend work: atomic quantity/idempotency/result lookup, reconciliation/capacity/provenance, formal condition/reject/disposition, session ownership/start/multi-shipment rules, refresh/device security and missing workflow contracts. Directed Picking, strict Putaway, Inventory and Returns have audited specifications, **not simulated implementations**.

Real-backend/DB/negative-permission validation, physical enterprise devices, warehouse pilot, signed update/rollback drill and final retirement are **not performed/approved**. Existing unit passes do not waive these gates.

## Evidence summary

- Frontend: **107 tests passed**; unrelated baseline typecheck failure remains in `LiveBoard.tsx:38`.
- Backend: **62 tests and Nest build passed**; no-engine Prisma type generation, not a live DB run.
- Current native CI at `c657be7`: **123 JVM tests (20 scanner + 103 core), Android build/lint and 19 executed Android instrumentation tests passed**. See [15](15-testing-report.md).
- Native UI/crypto execution: **19 tests passed** on an Android 30 emulator with a narrow 360dp viewport, both themes and 150% font scaling. This is not physical CT40 certification.
- Physical hardware / production pilot / cutover / retirement: **NOT RUN / NOT AUTHORIZED**.

**QA download:** [Receiving pilot APK artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981821576) · [Successful build and reports](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849). Debug/QA artifact only, not a production release. Native source verified at `c657be7d9572c66b2e24b7660779099b5d6a52c6`.

## Current update / التقرير المطلوب

[Full A–O device-aware Receiving report](device-aware-receiving-report.md) · [Native UI screenshots and test results](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981898482). Screenshots use labelled fixtures, not live warehouse data.

- PHONE: primary software scan, existing camera engine and manual fallback; compact worker/station header and touch navigation.
- CT40: dedicated internal device illustration, large ready/validation/success/error state, real Honeywell side trigger as primary input, minimal touch controls. No viewport-based detection or fake software trigger.
- One Receiving core, shared scanner/feedback/audio, safe confirmations/acknowledgement and no automatic stock replay. Old native Receiving/Tote implementations removed; backend/Admin/web services remain.
- Work Queue uses Material Outlined icon tiles and only actual Receiving counts. Unsupported permitted workflows are disabled without developer messages; unknown counts are not fabricated zeros.
- Settings expose worker/station identity and display preference; operational screens no longer show migration/API/debug copy.

Use an approved QA device/backend. Do not clear operational app data to bypass a signing/update error. Physical CT40 triggers, sound, glare, firmware and live stock/permission behavior still need acceptance.

## The nineteen deliverables

| # | Report | Scope/status |
|---|---|---|
| 01 | [Legacy Worker audit](01-worker-audit.md) | Source verified; W-01…10 findings. |
| 02 | [Component disposition matrix](02-component-matrix.md) | KEEP / REFACTOR / REBUILD / REMOVE / MISSING, with removal gates. |
| 03 | [API contracts](03-api-contracts.md) | Actual backend methods, permissions, schemas, effects, errors/retry limits; BC-01…06. |
| 04 | [Business logic extraction](04-business-logic.md) | Authority map, invalid legacy behavior and offline classifications. |
| 05 | [Native architecture](05-native-architecture.md) | Shared modules, layers, state/DI/session/recovery boundaries. |
| 06 | [Terminal design system](06-design-system.md) | Tokens, component catalog, hierarchy and accessibility/device gates. |
| 07 | [Scanner architecture](07-scanner-architecture.md) | Shared input rules and enterprise profile provisioning; physical certification pending. |
| 08 | [Roles and permissions](08-roles-permissions.md) | Backend enforcement, surface separation, auth/device controls and negative matrix. |
| 09 | [Receiving specification](09-receiving-spec.md) | Implemented pilot path and explicitly blocked parts of full acceptance. |
| 10 | [Picking specification](10-picking-spec.md) | Missing directed-pick contracts; not implemented. |
| 11 | [Putaway specification](11-putaway-spec.md) | Existing behavior audit, strict-location gate; not migrated. |
| 12 | [Inventory specification](12-inventory-spec.md) | Count/recount/variance/blind-count contract required. |
| 13 | [Returns specification](13-returns-spec.md) | Return/condition/disposition contract required. |
| 14 | [Ordered migration plan](14-migration-plan.md) | Freeze → audit → extract → migrate → validate → retire. |
| 15 | [Testing report](15-testing-report.md) | Executed versus authored/blocked test evidence. |
| 16 | [Hardware test report](16-hardware-test-report.md) | NOT RUN; 24 required physical cases and recording protocol. |
| 17 | [Production cutover](17-production-cutover.md) | NO-GO; controlled pilot, signing, monitoring and rollback runbook. |
| 18 | [Legacy retirement](18-legacy-retirement.md) | Not authorized; retained scope and proof required for removal. |
| 19 | [Cleanup report](19-cleanup-report.md) | Increment consolidation; final retirement cleanup still blocked. |

## Build / next gate

See [`mobile/README.md`](../../mobile/README.md) for JDK17/SDK35, HTTPS environment configuration and test/build commands. Register approved test workers/devices through existing Admin tools; no credentials in chat or Git.

Execute real API/DB and physical CT40 verification, resolve the required backend contract work, and execute the Receiving physical/API acceptance gate **before expanding new workflow screens or retiring legacy code**. Standing discipline: **CLEAN FIRST — NO ACCUMULATION**.
