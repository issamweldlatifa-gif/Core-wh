# AYROVI Worker Native App

This is the additive Android Native worker application planned in `docs/NATIVE-WORKER-APP-EXECUTION-PLAN.md`.

## Current stage: D1 scaffold

- Kotlin + Jetpack Compose application shell.
- Separate `scanner-core` library module with pure duplicate/debounce decision logic.
- Camera and internet permissions declared.
- No Admin UI is included.
- Backend integration, secure token storage, workflow context, CameraX/ML Kit, and offline sync are later stages.

## Build requirements

Android SDK 35 and Gradle/Android Studio are required. The repository sandbox does not include an Android SDK or emulator, so APK compilation must be verified on an Android development machine or CI runner.

From this directory:

```bash
./gradlew :app:assembleDebug
```

The app is intentionally additive and does not replace the existing web worker terminal.
