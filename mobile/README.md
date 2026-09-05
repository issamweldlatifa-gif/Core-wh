# AYROVI Worker · native migration pilot

This is the **existing** Kotlin/Compose Android project, application ID `com.ayrovi.worker`. No second app, WebView, production mock API or per-role package is introduced.

The new default experience is a **Receiving-first migration pilot**, not a completed production migration. The legacy web terminal and frozen native UI remain until all cutover gates pass. Missing backend contracts are not simulated.

## Build and verify

JDK 17, Android SDK/platform 35, build tools, and network access to Google Maven/Maven Central/Gradle are required.

```sh
cd mobile
./gradlew :scanner-core:test :worker-core:test :app:assembleDebug :app:lintDebug
# Optional compile/run instrumentation (actual emulator/device required):
./gradlew :app:assembleDebugAndroidTest
./gradlew :app:connectedDebugAndroidTest
```

Configure the existing AYROVI HTTPS `/api` root:

```sh
AYROVI_API_BASE_URL=https://your-approved-staging-host/api ./gradlew :app:assembleDebug
# or -PayroviApiBaseUrl=https://your-approved-staging-host/api
```

The original `https://core-wh.onrender.com/api` remains the compatibility default. Its deployment/version is not certified by a local build. No production credentials are in this project. Register the device code shown at sign-in through the existing Admin device registry and use an approved operational test account. API calls go directly to the configured real backend over HTTPS.

A debug APK is a QA artifact. Release builds are **not debug-signed**. Use the organization's signing/MDM pipeline only after the production gates; preserve signing identity for updates. CI uploads build artifacts without automatically deleting/publishing a rolling release.

## Scope and important safety limits

- New shell, work queue, secure auth, source-aware scanner, and one guided Receiving lane.
- Carton identification is separate from physical confirmation.
- Tote selection and one article per confirmed receipt use the real existing APIs.
- There is **no atomic bulk article API**, formal condition/reject contract, or authorized offline receipt protocol. No client-side N-request bulk loop or silent POST retry is implemented.
- An encrypted unresolved-mutation marker stops replay after network loss/process death. It is not an offline queue. A lost article receipt cannot be proved by aggregate totals; supervisor/server reconciliation is required.
- Other roles/workflows are not redesigned ahead of Receiving hardware acceptance. The queue explains that they remain in the approved legacy terminal for this pilot.

## Frozen native rollback

```sh
./gradlew :app:assembleDebug -PworkerLegacyFallback=true
```

This selects the frozen existing UI **inside the same app ID**, not another installed app. It retains audited baseline issues; verify a rollback artifact and operating procedure before use. The web fallback remains unchanged. Never switch clients while an unresolved receipt could be replayed. Keep signed rollback artifacts outside Git.

## Documents

[Migration dossier](../docs/worker-native/README.md) · [API contract / backend blockers](../docs/worker-native/03-api-contracts.md) · [Scanner provisioning](../docs/worker-native/07-scanner-architecture.md) · [Hardware evidence](../docs/worker-native/16-hardware-test-report.md).
