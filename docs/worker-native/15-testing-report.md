# 15 · Verification and regression report

Date: **2026-09-05**. Evidence below distinguishes executed tests, source review, authored tests and missing physical/live validation. A green JVM test is not a warehouse acceptance test.

## Executed evidence

| Check | Result / scope |
|---|---|
| Frontend `npm test -- --maxWorkers=2` | **PASS: 10 files / 107 tests** on frozen source. Scanner/unit coverage, not browser→backend E2E. |
| Frontend `npm run typecheck` | **FAIL, pre-existing:** `src/admin/pages/LiveBoard.tsx:38`, `AuthContextValue.token` does not exist. No passing frontend build claimed. No frontend source changes in this migration. |
| Backend `npm test -- --runInBand` | **PASS: 9 suites / 62 tests** after Prisma client type generation. Mocks/unit tests, no live PostgreSQL integration. |
| Backend `npm run build` | **PASS** (Nest/TypeScript compile). Not a deployed/runtime or database check. |
| Local Android Gradle | **BLOCKED:** no JDK/Android SDK; `./gradlew --version` reports no JAVA_HOME/java. Official toolchain/CDN downloads failed TLS/network access; TLS verification was never disabled. |
| Native JVM in GitHub CI, `cbbd21c` | **PASS: scanner-core 20; worker-core 54; zero failures/skips.** This run subsequently failed Android UI compilation. |
| Android compile/lint/instrumentation APK at `12ef374` | **PASS** in CI run34000291129: 20 scanner + 60 core tests, debug APK, lint, and instrumentation APK compile. Later hardening requires final rerun. |
| Instrumentation execution | **NOT RUN.** Seven Android UI/secure-storage tests authored. Optional manual CI dispatch denied by integration (403); GitHub reconnection/workflow access needed. |
| Real AYROVI API / PostgreSQL E2E | **NOT RUN.** No test endpoint/account/deployment/schema certification. No production stock mutation performed. |
| Physical devices / pilot / cutover / retirement | **NOT RUN / NOT AUTHORIZED.** See 16–19. |

Backend generation workaround used only to obtain client types:

```sh
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true npx prisma generate --no-engine
npm test -- --runInBand
npm run build
```

This does not install a functional local Prisma engine or prove database behavior. Earlier missing-generated-client compile failures are superseded by the 62-test pass. Frontend dependencies installed with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` and the system CA; no insecure TLS bypass.

## Native CI history

- [Run 33999891566](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/33999891566), `e455c50`: Gradle script `java.net` shadowed by Gradle's Java extension. Fixed with an explicit URI import.
- [Run 34000020763](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34000020763), `cbbd21c`: 74 JVM tests passed. Android compiler identified missing SideEffect import and two cross-module nullable smart casts in the frozen UI. Minimal compatibility fixes applied, not a legacy redesign.
- [Run 34000291129](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34000291129), `12ef374`: **PASS**, 20 scanner + 60 core tests; Android debug APK, lint and test APK compile. APK produced as an Actions QA artifact; instrumentation execution was skipped. Additional transition/concurrency hardening is awaiting its final rerun.

CI emits test counts/compiler/lint annotations accessible through the Checks API. Full reports/APK are controlled Actions artifacts. Direct artifact/log CDN retrieval from this sandbox can fail; an accessible annotation is not a substitute for a missing test category. No automatic canary release, gist publication, deployment or fleet update is part of this workflow.

## Authored native coverage

- Existing scanner-core tests retained; new source-aware manager tests: sliding held-label suppression, rearm, cross-source duplicates, disabled/background input, held trigger across busy interval, exact case/unicode/GS1 separator, invalid/oversize input, QR/manual/source metadata, cancel/timeout/unavailable, capture ≠ receipt.
- ReceivingWorkflow: actual queue/active-session recovery; identify ≠ accept; received event; pause/resume; rapid scan/tap guard; wrong/unknown/duplicate carton; invalid tote; SKU/reference distinction; review before receipt; one real article endpoint; invalid/bulk quantity blocked; unexpected article recorded with exception; persistent ambiguity; no aggregate inference/replay; server closure; worker isolation; storage failure; 403/401; malformed success; follow-up read failure; offline/permission changes; variance resolution and meaningful exception reason.
- Transport: HTTPS/config, exact login fields, array error reasons, single-flight refresh, logout/new-login/late-response races, no POST retry/redirect, offline preflight, unrecognized proxy response, local logout despite network failure, URL escaping and token redaction.
- Policy/session: server task filtering, role label denial, wrong surface/worker context, no module-count fabrication, default-deny offline classification, token identity generation, no queue access without permissions, absent quantities fail contract decoding.
- Android tests (authored, not executed): encrypted token/journal XML, stable identity + pending preservation on logout/reopen, purge of old plaintext credentials, stale CAS rejection, touch target/disabled state, expected/scanned error content and font scaling.

Fixtures/fake gateways exist **only in test source sets**. Production code has one real repository, no mock data or fake workflow service.

## Outstanding verification gates

1. Passing final native build/lint and test APK compilation for the actual final commit.
2. Run instrumentation on a disposable approved test environment; no real credentials in tests.
3. Deploy source-matching staging backend/schema and execute role-negative/API/DB receipt tests, concurrency/idempotency and BC-01…06 fixes.
4. Execute the complete device matrix in report16, including camera/hardware/manual/source/cancel/network/process/auth scenarios.
5. Run approved web/native fallback + Admin/backend regression. Resolve/triage W-10 rather than claiming a clean frontend build.
6. All requested critical workflows and pilot metrics before cutover. Receiving-only tests cannot satisfy full migration acceptance.
