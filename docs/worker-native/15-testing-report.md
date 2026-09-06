# 15 · Verification and regression report

**v1.5.0 device-aware update verified:** distinct Phone/CT40 presentations, reused device detection, centralized audio/feedback and icon queue. **123 JVM tests and 19 Android instrumentation tests passed**, plus APK build/lint. Emulator evidence is separate from physical warehouse acceptance.

Date: **2026-09-06**. Latest verified native source: **`c657be7d9572c66b2e24b7660779099b5d6a52c6`** on `arena/01a073df-core-wh`. Subsequent dossier-only edits do not change this tested source.

**Native build is green. Warehouse/production acceptance is not complete.** Executed tests, source review, authored tests and missing physical/live validation are separate evidence categories.

## Executed evidence

| Check | Result / scope |
|---|---|
| Native `:scanner-core:test` | **PASS: 20 tests, 0 failures, 0 skipped.** |
| Native `:worker-core:test` | **PASS: 103 tests, 0 failures, 0 skipped.** |
| Native `:app:assembleDebug` | **PASS.** Kotlin/Compose Android QA APK built and uploaded. |
| Native `:app:lintDebug` | **PASS.** No claim that physical accessibility/device ergonomics passed. |
| Native `:app:assembleDebugAndroidTest` | **PASS.** Nineteen instrumentation cases compile and execute in the emulator job. |
| Android instrumentation execution | **PASS: 19 tests, 0 failures, 0 skipped**, Android 30 emulator, Google APIs/x86_64, 720×1280/density 320 (360dp viewport). Automatic push/PR test execution is configured; manual-dispatch permissions are not required for that CI trigger. |
| Frontend `npm test -- --maxWorkers=2` | **PASS: 10 files / 107 tests** on frozen source. Unit/scanner coverage, not browser→backend E2E. |
| Frontend `npm run typecheck` | **FAIL, pre-existing:** `src/admin/pages/LiveBoard.tsx:38`, `AuthContextValue.token` does not exist. No passing frontend build claimed. |
| Backend `npm test -- --runInBand` | **PASS: 9 suites / 62 tests** after Prisma client type generation. Mocks/unit tests, no live PostgreSQL integration. |
| Backend `npm run build` | **PASS** (Nest/TypeScript compile). Not a deployed/runtime or database check. |
| Local Android Gradle | **BLOCKED:** sandbox lacks JDK/Android SDK; `./gradlew --version` reports no JAVA_HOME/java. Official toolchain downloads failed network/TLS access. CI supplied the build environment; TLS verification was never disabled. |
| Real AYROVI API / PostgreSQL E2E | **NOT RUN.** No staging deployment/account/schema certification. No production stock mutation performed. |
| Physical devices / pilot / cutover / retirement | **NOT RUN / NOT AUTHORIZED.** See 16–19. |

## Final native CI and artifact

[Successful run 34008673849](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849), source `c657be7`, executed:

```sh
./gradlew :scanner-core:test :worker-core:test :app:assembleDebug :app:lintDebug :app:assembleDebugAndroidTest --no-daemon --stacktrace --console=plain
```

- **123 JVM tests passed**; native build/lint/test-APK compilation passed. The subsequent emulator job executed `:app:connectedDebugAndroidTest`: **19 tests passed**.
- [Receiving pilot QA APK artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981821576): `ayrovi-worker-receiving-pilot-c657be7d9572c66b2e24b7660779099b5d6a52c6`.
- [Verification reports artifact](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981821154).
- Actions **artifact archive** digest: `sha256:0e692d2a102dae6295946fbeebca1c2862087f81819b2f3fa60fc6d90da11149`. This is the ZIP/archive digest, **not** an independently measured APK hash or signing certificate.
- [Executed emulator results](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849/artifacts/9981898482). **10 native UI screenshots were collected.** They are synthetic fixture captures, not live warehouse data. Artifact download into the sandbox still fails (Azure CDN EOF), so no local screenshot visual review or APK installation is claimed. Counts/results were verified through Actions/Checks APIs.
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
| `b0771e8` / [34002636062](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34002636062) | **v1.4.0 PASS: 91 JVM tests**; one-shot request bodies also prevent internal HTTP503 follow-up replay. |
| `b86416c` / [34005745773](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34005745773) | **v1.4.1 PASS: 106 JVM + 12 Android emulator tests**, build/lint/test-APK; WHITE/BLACK and Carton/Produit. |

Latest device-aware run [34008673849](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34008673849) verified source `c657be7` with **123 JVM + 19 Android tests**, APK/lint and 10 fixture screenshots. Earlier failed builds exposed operator-import/nullable-cross-module/test-assertion compilation issues, corrected before this run.

Historical v1.4.0 manual dispatch was permission-restricted. For this UI update the existing CI workflow now runs emulator checks automatically after a successful native build on push/PR. That job actually ran and passed; it is not a physical-device test or deployment.

## Native coverage

- Scanner: sliding held-label suppression, explicit rearm, cross-source duplicates, disabled/background capture, held input across busy interval, exact case/unicode/GS1 separator, invalid/oversize input, QR/manual/source metadata, cancel/timeout/unavailable, capture ≠ receipt. Frozen scanner reference tests retained.
- Receiving: real gateway queue/active-session recovery; identify ≠ accept; matching received event; pause/resume and server-side pause changes; rapid scan/tap guard; wrong/unknown/duplicate carton; invalid tote; SKU/reference distinction; review before receipt; one article endpoint; invalid/bulk quantity blocked; unexpected article recorded with exception; no aggregate inference/replay; worker isolation; storage failure; 403/401; malformed/numeric success identifier; follow-up GET failure; offline/permission changes; required source carton; variance authority and actual exception reason.
- Confirmed receipt recovery: persist the server's ArticleUnit/tote evidence before rendering success, restore it without another POST/success beep, and require explicit worker acknowledgement before the next unit. A failed acknowledgement read retains the evidence.
- Transport: HTTPS/config, exact login contract, error arrays, single-flight refresh, logout/new-login/late-response races, durable local sign-out before remote revocation, no automatic POST connection/redirect/**503 Retry-After:0** replay, offline preflight, safe proxy/server error handling, URL escaping and token redaction.
- Session/policy: server task filtering, role-label denial, wrong surface/worker identity, no module-count fabrication, default-deny offline classification, token identity generations, no Receiving queue read without permissions, missing quantities fail contract decoding.
- The initial twelve Android cases (retained regression coverage): the previous eight UI/secure-storage cases, plus both-palette contrast, appearance persistence isolated from auth, theme/mode switching in the same Receiving ViewModel with zero stock writes, and narrow-viewport navigation at 150% font scaling. Tests label their data UI TEST FIXTURE.
- Fifteen additional core mode cases cover continuous cartons, product prerequisites, preview/source separation, draft discard, reused/closed tote, removed/rejected source, busy/offline/revoked/paused/closed states, acknowledged/unknown/other-worker holds, read failure and duplicate cartons.

- Current device-aware additions: detector model/fallback cases; Phone versus CT40 at the same viewport; compact-header bounds and large-font CT40 navigation; compact queue/real badges/disabled availability; synthetic Honeywell broadcast → core → validation → feedback/audio-port → confirmations → completion. Total **19 Android cases executed/passed**.
- A full JVM scan-to-completion journey uses the **production WorkerRepository and HTTP transport** against a local contract test server; this is distinct from an unperformed live AYROVI DB test. Shared feedback, sound-failure/mute/DND policy, held-duplicate throttling, background behavior, automatic simple-error return, business versus network refusal and real queue-count policies are covered.

Complete A–O detail: [Device-aware Receiving report](device-aware-receiving-report.md).

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

1. Repeat secure-store upgrade and appearance/navigation checks on the actual managed CT40/target Android builds; emulator tests do not certify firmware, glare, gloves or hardware triggers.
2. Deploy source-matching staging backend/schema and execute permission-negative/API/DB receipt tests, concurrency/idempotency and BC-01…06 work.
3. Execute the device matrix in report16, including real triggers, scanner profiles, network/process/auth interruption and physical stock/label/tote reconciliation.
4. Run approved legacy/Admin/backend regression; resolve/triage W-10 instead of claiming a clean frontend build.
5. Complete every required critical workflow, controlled warehouse pilot, signing/update/rollback and retirement gates. Receiving JVM/compile evidence does not satisfy full migration acceptance.
