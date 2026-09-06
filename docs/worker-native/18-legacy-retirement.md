# 18 · Legacy retirement report and removal gates

## Status: LEGACY RETAINED / RETIREMENT NOT AUTHORIZED

Required sequence is **FREEZE → AUDIT → DOCUMENT → EXTRACT → MIGRATE → VALIDATE → RETIRE**. This change has reached an implemented/tested-in-part Receiving migration slice, not completed production validation. No old Worker routes/screens were deleted. No backend/Admin functions were removed.

One existing Android package is evolved. Frozen native UI is an explicit build-time rollback/reference, not another permanent Worker app or a per-role app. Frozen web Worker remains in the shared Admin deployment until safe retirement. The fact that both references temporarily exist is documented transition debt with gates, not the final architecture.

## Work already performed

- Audited React/native/backend behavior and marked invalid assumptions in reports01–04.
- Extracted existing DTOs and WorkerRepository to one shared JVM module; removed the old app-local copies by moving/refactoring, not by creating a second API implementation.
- Shared scanner decision/coordinator and native camera/Honeywell adapters refactored; DataWedge feeds the same pipeline. No JS scanner embedded in Android.
- New terminal design system/session use case/Receiving use case implemented in the existing app.
- Frozen native UI changed only for shared dependency injection, cross-module compilation and lifecycle integration; its audited receipt/routing defects are not silently claimed fixed.
- Build-time fallback is blocked if unresolved native work exists. Web fallback source remains unchanged.

## Conditions before removal approval

All critical workflows real and authorized; BC-01…06 resolved as applicable; no false success/stock duplication; session/device/logout/expiry secure; backend permission-negative matrix; safe online/offline/sync policy; physical enterprise scanners and interruptions passed; controlled warehouse pilot/stabilization; rollback drill; no critical Worker/Admin/backend regressions; approved sign-off from warehouse, QA, backend, Android/security and release owners.

None of those multi-party acceptance signatures exists in this session. Reports10–13 are specs, not completed workflows.

## Removal inventory after approval

| Candidate | Proof required before deletion |
|---|---|
| `frontend/src/terminal/*`, `/terminal/*` routes and Worker-only redirects | Every role/workflow migrated; route/usage analytics and import search; approved user/deployment transition. Preserve Admin routing/auth. |
| Worker-specific legacy Receiving UI/scanner hosts | No active legacy entry or shared Admin consumer. Native parity and printer/label/camera edge cases verified. |
| Web Worker scanner/OCR/ONNX assets/dependencies | Import/build graph proves Worker-only use; remove exact dependency/assets, not shared recognition or Admin tools by association. |
| Frozen native `ui/Screens.kt` and `WORKER_LEGACY_FALLBACK` flag | All workflows completed, signed rollback no longer required, new native operational parity and hardware proven. |
| Legacy station-local API/state/quantity handling | Valid rules extracted or backend-owned; no hidden production consumer. Do not retain alternate mutation paths in the new UI. |
| Native generic unused OfflineQueue/OCR normalizer reference | Policy/learning/test evidence captured; no approved production consumer. Never enable the queue just to avoid deleting it. |
| Old DTO fields/endpoints | API consumers and backward compatibility audited. Shared backend service/API removal needs separate proof and owner approval. |
| Built deployment assets, admin auth/client, SSE, CRM integration | **Not presumed obsolete.** These support shared production/Admin functionality. Keep unless independently approved. |

## Retirement execution record (future)

Record approved commit, removed paths/dependencies/routes, downstream consumer checks, build/test results, backup/rollback locations and hashes, deployment version, redirect/deprecation decisions, monitoring window and defects. Remove temporary flags/adapters/docs that imply two ongoing products. Update the component matrix and report19.

The exit criterion is a single supported native Worker implementation plus necessary backend/Admin functionality—not “delete everything old” or merely hide its navigation.

## Device-aware Receiving replacement

The user-authorized replacement removes native `ReceivingStation`, `ToteStation`, their native route mappings and the unused totals-only native repository call. There is now exactly one native Receiving workflow/route with Phone and CT40 rendering. Other frozen native operations, React Worker fallback, backend services and Admin remain; this targeted removal is **not** full legacy retirement or production cutover approval.
