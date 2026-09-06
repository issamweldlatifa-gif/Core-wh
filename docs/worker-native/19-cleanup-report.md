# 19 · Final cleanup report / current migration checkpoint

## Result: INCREMENT CLEANUP PERFORMED; FINAL RETIREMENT CLEANUP BLOCKED

This is not a claim that the overall migration is complete. The legacy retention and missing hardware/workflow contracts are intentional and explicitly gated in reports14/16–18.

## Cleaned / consolidated in this increment

- Reused `mobile/` and `com.ayrovi.worker`; one application/launcher, no WebView/PWA wrapper, no second per-role application.
- Moved existing native DTOs and repository to worker-core, removed former app-local files. One endpoint implementation remains; new use cases call it instead of copying API code into Compose.
- Reused/refactored shared scanner decision/coordinator/camera/Honeywell integration; one new DataWedge adapter, no per-workflow scanner.
- Centralized new UI tokens and controls in design-system; migrated operational surfaces consume them. Frozen UI remains a named temporary exception.
- Removed plaintext token fallback. Purge old raw credentials, preserve/securely migrate non-secret device identity, retain unresolved marker across logout.
- Removed native live OCR auto-accept path and unused app OCR dependency; retained frozen pure reference/test material per matrix rather than inventing OCR-based stock authorization.
- Removed app's direct OkHttp dependency after transport moved to core. Android dependencies are not copied into the JVM domain module.
- Removed automatic canary release deletion/publication and failure-log gist upload. CI produces controlled reports/APK artifacts only; release is not debug-signed.
- No generated APKs, dependencies, toolchains, test corpora, videos, secrets or credentials intentionally added to Git. Build/report output stays in ignored paths/Actions artifacts.

## Deliberately retained (not hidden debt)

| Retained item | Why / exit gate |
|---|---|
| React Worker routes/UI/API/scanner/assets | Temporary reference/approved fallback; all workflow/hardware/pilot retirement gates still open. |
| Native frozen Screens.kt + build flag | Same-app rollback/reference; minimal shared-infrastructure/compile fixes only. Not a second ongoing feature branch. |
| Legacy API methods/DTOs for sorting/order sorting/packing/shipping/trace | Existing working backend consumers; no full replacement accepted. |
| Deprecated totals-only Receiving API method | Frozen client compatibility; new lane never calls it. Remove only when all consumers migrate. |
| Unused generic OfflineQueue and OCR normalizer/tests | Explicit frozen reference; not wired into live new flow. Remove at approved reference-retirement gate. |
| Backend schema/controllers/services/Admin UI/deployment assets | Needed shared functionality; no evidence/approval for deletion. |

## Final review checklist

- [x] Existing equivalents searched before introducing module/service/component.
- [x] No second production API implementation, scanner engine or application ID.
- [x] No native stock outbox, bulk receipt loop or frontend-only permission bypass.
- [x] No silent backend/schema/permission contract modifications.
- [x] Backend-invalid legacy assumptions documented rather than copied as truth.
- [x] Source/test/contract/plan/hardware evidence distinguished; limitations not labeled complete.
- [ ] Final native verification for final commit recorded in report15.
- [ ] Real backend/DB/role/hardware/pilot evidence accepted.
- [ ] All requested critical workflows migrated.
- [ ] Legacy retirement approved/executed and entire dependency/import/route graph cleaned.
- [ ] Final production cutover/regression/monitoring sign-off.

Standing governance remains **CLEAN FIRST — NO ACCUMULATION**: audit → design → implement → integrate → test → clean → document for each increment. Do not implement additional screens while Receiving physical acceptance is still blocked, and do not remove fallback/backend/Admin code just to make this checklist appear complete.
