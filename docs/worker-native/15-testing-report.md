# 15 · Verification and regression report

Date: **2026-09-06**. Latest verified native source: **`b0771e89e77c41d29c16a472ebd065b6dc9132a5`** on `arena/01a073df-core-wh`. Subsequent dossier-only edits do not change this tested source.

**Native build is green. Warehouse/production acceptance is not complete.** Executed tests, source review, authored tests and missing physical/live validation are separate evidence categories.

## Executed evidence

| Check | Result / scope |
|---|---|
| Native `:scanner-core:test` | **PASS: 20 tests, 0 failures, 0 skipped.** |
| Native `:worker-core:test` | **PASS: 71 tests, 0 failures, 0 skipped.** |
| Native `:app:assembleDebug` | **PASS.** Kotlin/Compose Android QA APK built and uploaded. |
| Native `:app:lintDebug` | **PASS.** No claim that physical accessibility/device ergonomics passed. |
| Native `:app:assembleDebugAndroidTest` | **PASS.** Eight instrumentation test cases compile; not executed. |
| Android instrumentation execution | **NOT RUN.** Manual workflow dispatch remains denied (403) by the GitHub integration, including after reconnection. Run through an authorized Actions account or an approved Android test environment. |
| Frontend `npm test -- --maxWorkers=2` | **PASS: 10 files / 107 tests** on frozen source. Unit/scanner coverage, not browser→backend E2E. |
| Frontend `npm run typecheck` | **FAIL, pre-existing:** `src/admin/pages/LiveBoard.tsx:38`, `AuthContextValue.token` does not exist. No passing frontend build claimed. |
| Backend `npm test -- --runInBand` | **PASS: 9 suites / 62 tests** after Prisma client type generation. Mocks/unit tests, no live PostgreSQL integration. |
| Backend `npm run build` | **PASS** (Nest/TypeScript compile). Not a deployed/runtime or database check. |
| Local Android Gradle | **BLOCKED:** sandbox lacks JDK/Android SDK; `./gradlew --version` reports no JAVA_HOME/java. Official toolchain downloads failed network/TLS access. CI supplied the build environment; TLS verification was never disabled. |
| Real AYROVI API / PostgreSQL E2E | **NOT RUN.** No staging deployment/account/schema certification. No production stock mutation performed. |
| Physical devices / pilot / cutover / retirement | **NOT RUN / NOT AUTHORIZED.** See 16–19. |

## Final native CI and artifact

[Successful run 34002636062](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002636062), source `b0771e8`, executed:

```sh
./gradlew :scanner-core:test :worker-core:test :app:assembleDebug :app:lintDebug :app:assembleDebugAndroidTest --no-daemon --stacktrace --console=plain
```

- **91 JVM tests passed** in total; native build/lint/test-APK compilation passed.
- [Receiving pilot QA APK artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002636062/artifacts/9979997734): `ayrovi-worker-receiving-pilot-b0771e89e77c41d29c16a472ebd065b6dc9132a5`.
- [Verification reports artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002636062/artifacts/9979997108).
- Actions **artifact archive** digest: `sha256:aeaf3d0150eba04d40997b4b80adec482e4f4affa4b616a9dda3a576e73c39be`. This is the ZIP/archive digest, **not** an independently measured APK hash or signing certificate.
- Artifact/log CDN downloads into the sandbox failed (EOF); no APK was copied into Git or presented as locally installed. Counts/results were verified through the Actions/Checks APIs.
- CI reports a Node20 action-runtime deprecation warning; the affected actions were forced onto Node24 and this run passed. Review/update/pin the release toolchain before production qualification.

Artifacts are debug/QA outputs, not release signing or permission for a fleet update. No automatic canary release, gist publication, deployment or production rollout is part of this workflow.

## CI history and corrections

| Source / run | Evidence |
|---|---|
| `e455c50` / [33999891566](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/33999891566) | Gradle `java.net` name shadowed by the Java extension. Fixed with explicit URI import. |
| `cbbd21c` / [34000020763](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34000020763) | 74 JVM tests passed; three frozen-UI compile errors (SideEffect import/two cross-module smart casts) fixed with minimal compatibility changes. |
| `12ef374` / [34000291129](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34000291129) | PASS: 80 JVM tests, Android build/lint/test-APK compile. |
| `0280d8c` / [34000890864](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34000890864) | PASS: transition/modal/connection hardening build. |
| `de53ee1` / [34001893748](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34001893748) | PASS: 89 JVM tests plus Android checks; durable receipt acknowledgement and immediate local logout. |
| `6aec73e` / [34002270403](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002270403) | PASS: lifecycle/interruption/startup and terminal system-bar checks. |
| `b0771e8` / [34002636062](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002636062) | **Final native PASS: 91 JVM tests**; one-shot request bodies also prevent internal HTTP503 follow-up replay. |

GitHub authentication briefly expired (401); the user reconnected and push/check access resumed. Optional manual dispatch remains permission-restricted, not silently reported as executed.

## Native coverage

- Scanner: sliding held-label suppression, explicit rearm, cross-source duplicates, disabled/background capture, held input across busy interval, exact case/unicode/GS1 separator, invalid/oversize input, QR/manual/source metadata, cancel/timeout/unavailable, capture ≠ receipt. Frozen scanner reference tests retained.
- Receiving: real gateway queue/active-session recovery; identify ≠ accept; matching received event; pause/resume and server-side pause changes; rapid scan/tap guard; wrong/unknown/duplicate carton; invalid tote; SKU/reference distinction; review before receipt; one article endpoint; invalid/bulk quantity blocked; unexpected article recorded with exception; no aggregate inference/replay; worker isolation; storage failure; 403/401; malformed/numeric success identifier; follow-up GET failure; offline/permission changes; required source carton; variance authority and actual exception reason.
- Confirmed receipt recovery: persist the server's ArticleUnit/tote evidence before rendering success, restore it without another POST/success beep, and require explicit worker acknowledgement before the next unit. A failed acknowledgement read retains the evidence.
- Transport: HTTPS/config, exact login contract, error arrays, single-flight refresh, logout/new-login/late-response races, durable local sign-out before remote revocation, no automatic POST connection/redirect/**503 Retry-After:0** replay, offline preflight, safe proxy/server error handling, URL escaping and token redaction.
- Session/policy: server task filtering, role-label denial, wrong surface/worker identity, no module-count fabrication, default-deny offline classification, token identity generations, no Receiving queue read without permissions, missing quantities fail contract decoding.
- Eight Android cases (compiled, **not executed**): encrypted token/journal XML; stable identity + pending preservation on logout/reopen; legacy plaintext purge; stale CAS rejection; confirmed-receipt persistence; gloved touch size/disabled state; expected/scanned error context; increased font scale.

Fixtures/fake gateways exist **only in test source sets**. Production code has one real repository, not a demo backend or simulated task data.

## Backend/frontend reproduction notes

Backend generation workaround used only to obtain client types:

```sh
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true npx prisma generate --no-engine
npm test -- --runInBand
npm run build
```

This does not install a functional local Prisma engine or prove database behavior. Earlier missing-generated-client failures are superseded by the 62-test pass. Frontend dependencies installed with `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` and the system CA, without a TLS bypass.

Static review also verified all 19 numbered reports and their relative links, one production WorkerRepository/HttpWorkerTransport/ScannerManager/ScanDecision, no backend/frontend source changes versus `4b762cf`, and clean whitespace diffs. Design token contrast calculations are in report06.

## Remaining acceptance gates

1. Execute instrumentation and secure-store upgrade checks on approved Android environments.
2. Deploy source-matching staging backend/schema and execute permission-negative/API/DB receipt tests, concurrency/idempotency and BC-01…06 work.
3. Execute the device matrix in report16, including real triggers, scanner profiles, network/process/auth interruption and physical stock/label/tote reconciliation.
4. Run approved legacy/Admin/backend regression; resolve/triage W-10 instead of claiming a clean frontend build.
5. Complete every required critical workflow, controlled warehouse pilot, signing/update/rollback and retirement gates. Receiving JVM/compile evidence does not satisfy full migration acceptance.
