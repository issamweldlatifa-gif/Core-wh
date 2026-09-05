# 14 · Controlled migration plan

**Target:** one native Worker App (`com.ayrovi.worker`), one core/client, one scanner architecture, one terminal design system. Native lives in existing `mobile/`. Web legacy is temporary, not a parallel product roadmap.

## Ordered gates

| Phase | Work | Gate / current disposition |
|---|---|---|
| 1 | Freeze and source audit | Reports 01–02; web Worker files preserved. |
| 2 | Backend/API audit | Report 03; verify source now, deployed contract separately. |
| 3 | Extract valid rules | Report 04; reject incorrect frontend assumptions. |
| 4 | Native architecture | Evolve existing app, shared JVM core, ViewModels, single transport; no second ID. |
| 5 | Design system | Tokens and terminal primitives; migrated routes only use shared system. |
| 6 | Authentication | Secure fail-closed store, stable device code, shared refresh and auth-state handling. |
| 7 | Scanner service | Shared source-aware manager; CameraX/Honeywell reuse; DataWedge adapter; hardware acceptance pending. |
| 8 | Receiving | Integrated carton/tote/article online lane. Existing API supports one article per confirmation; no formal condition/reject/bulk contract. **Not full production acceptance.** |
| 9 | Real backend integration | Existing endpoints only. Contract tests do not certify deployed backend. Critical BC-01…05 findings must be resolved before go-live. |
| 10 | Physical device | **BLOCKED** until authorized hardware/operator available; report16. |
| 11 | Directed Picking | Spec10 only. Do not implement screens before phase10 and backend contract. |
| 12 | Strict Putaway | Spec11; backend strict-location approval first. Existing fallback remains. |
| 13 | Inventory | Spec12; missing backend count model/authorization. |
| 14 | Returns | Spec13; missing disposition/rejection model. |
| 15 | Role/permission validation | Real worker/supervisor matrices; negative API tests. |
| 16 | Authorized offline/sync | Default all stock writes require server. Offline outbox only with approved protocol. |
| 17 | Full regression | Native + legacy fallback + admin/backend; unrelated baseline failures must be tracked. |
| 18 | Production pilot | Controlled fleet/cohort and warehouse approval, not automatic branch APK publication. |
| 19 | Cutover / retire | Reports17–19; **not authorized yet**. |

## Single-application transition

- Existing web bundle and routes remain unchanged for fallback/reference. Do not delete shared Admin code.
- Existing native UI stays as a build-time rollback in the same package; no second launcher/app, no runtime role-bypass toggle. No new features there.
- Native pilot is explicitly a migration build. Non-migrated operational workflows retain their existing implementation/reference; nothing is advertised as production-complete simply because it renders.
- The new Receiving lane consumes the **same** WorkerRepository and scanner core, never another production client/scanner.
- Keep old signed installable artifact externally with hash/certificate/version before a hardware pilot. Git source is not an installable rollback; downgrade/update strategy must be tested.

## Change discipline

For every increment: AUDIT → DESIGN → IMPLEMENT → INTEGRATE → TEST → CLEAN → DOCUMENT.

Before adding any endpoint/component/rule, search existing equivalents, name the owning layer and record migration disposition. Backend changes are separately documented; no silent contract expansion. No feature breadth ahead of Receiving acceptance. Never delete a fallback merely because a new screen launches.

## Decisions requiring warehouse/backend owner input

1. Formal receiving condition/rejection reasons, disposition/quantity semantics and supervisor override.
2. Atomic article quantity/idempotency/operation lookup, concurrency and source-carton requirements.
3. Cross-worker session takeover and multi-warehouse/multi-shipment policy.
4. Directed-pick task contract, strict putaway exceptions, blind-count authorization, returns decisions.
5. Target hardware/Android/DataWedge/Honeywell versions, managed scanner profile, signing identity and staging API deployment.

Do not request passwords or production data in chat. Configure a test environment and managed test identities through the existing Admin/secret-management process.
