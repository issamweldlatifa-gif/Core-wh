# AYROVI Worker · Native Android migration dossier

**v1.4.1 pilot / CT40-oriented update:** white/black themes, one-tap Carton/Produit modes, compact cards and fixed task navigation. Full production migration is NOT COMPLETE.

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
- Current native CI at `b86416c`: **106 JVM tests (20 scanner + 86 core), Android build/lint and 12 executed Android instrumentation tests passed**. See [15](15-testing-report.md).
- Native UI/crypto execution: **12 tests passed** on an Android 30 emulator with a narrow 360dp viewport, both themes and 150% font scaling. This is not physical CT40 certification.
- Physical hardware / production pilot / cutover / retirement: **NOT RUN / NOT AUTHORIZED**.

**QA download:** [Receiving pilot APK artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34005745773/artifacts/9980922788) · [Successful build and reports](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34005745773). Debug/QA artifact only, not a production release. Native source verified at `b86416c06056b7ad0ee240f8c56244f5004e144a`.

## تجربة التحديث / Try this update

1. In the header, tap **BLACK / WHITE** to switch contrast without restarting the task.
2. In Receiving, tap **CARTON** to receive cartons continuously, or **PRODUIT** to enter the product lane. A required source carton and ACTIVE receiving tote still have to be verified.
3. Use the header Back button and **TASK ACTIONS** menu; camera/manual fallbacks are kept together and manual entry expands on demand.
4. Existing stock/permission/recovery rules remain in the shared core/backend, not in theme/layout code. Never clear an unresolved receipt to switch modes.

Use an approved QA device/backend. Do not clear operational app data to bypass a signing/update error. Test real CT40 glare, keyboard, buttons and scanner profile before approving rollout.

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
