# 05 · Native architecture and implementation boundaries

## Decision

Evolve **existing `mobile/`**. Keep application ID `com.ayrovi.worker`, one single-task Activity/launcher. Kotlin + Android SDK + Compose; MVVM; coroutines/StateFlow; repository and use-case boundaries; explicit constructor injection. No WebView/PWA/second application. Manual dependency injection is intentional: a small `AppContainer` + ViewModel factories gives a single API client/session store without introducing a second container/framework.

```
:app
  MainActivity → WorkerTerminalApp (render + intents)
    WorkerAppViewModel / ReceivingViewModel (lifecycle)
      :worker-core
        WorkerSessionUseCase (verified identity/context)
        ReceivingWorkflow (one guided use case + StateFlow)
          ReceivingGateway ← WorkerRepository (existing endpoint implementation)
            WorkerTransport → OkHttp → existing /api/v1
            SessionStorage ← Android Keystore-backed SessionStore
            MutationJournal ← encrypted local unresolved-write marker
      :scanner-core
        ScanResult / ScannerState / ScannerManager / ScanDecision
          ← :app ScannerService / ScanCoordinator
              ← CameraX + ML Kit / Honeywell / DataWedge / manual
      :design-system
        terminal tokens + shared Compose components
```

The frozen `ui/Screens.kt` remains a build-time rollback/reference. It reuses the same extracted repository/transport/scanner; it must not receive new features. The native pilot does not claim that unmigrated screens meet the new architectural rules. Web fallback remains unchanged. No rewrite of the existing Admin app.

## State ownership

- Backend: permissions, work assignments, arrival/session status, expected/received totals, stock/article transitions and discrepancies.
- Core workflow: selected task/tote/product, current instruction, scan→review→confirm sequencing, busy guard, uncertainty handling. Never increments server counts locally.
- ViewModel: binds lifecycle and exposes immutable StateFlow. Compose does not call a repository or encode API bodies in the migrated lane.
- Scanner: capture, bounded transport input, source metadata, duplicate suppression, timeout/cancel/unavailable. Never authorizes a product/location or mutates stock.
- Encrypted store: token pair, stable installation device code, unresolved mutation marker. No plaintext fallback. No password persisted. Backup disabled.
- Process recovery: reauthenticate/reload server session from worker context; no automatic replay of drafts. Re-scan tote/product after process death. An unresolved article receipt remains a stop condition.

## Transport rules

One authenticated transport, one serialization definition per API, pinned dependencies. HTTPS environment configuration only in production. No request/body/token logging. Close every response. Disable automatic connection retries and redirects for the shared client. Single-flight refresh compares token and login identity generations so late failures cannot erase a new login or resurrect a signed-out session.

A definitive 401 may be refreshed once before repeating the unauthorized request. A network failure/5xx after a mutation is **outcome unknown**, not a safe retry. No generic POST retry policy. Write bodies are explicitly one-shot so OkHttp cannot follow up a 503 Retry-After response by silently replaying a mutation; the separately controlled definite-401 refresh creates a new request. Validate endpoint/response shape; a missing success discriminator is not success.

## Connection and recovery

ONLINE means a backend request succeeded, not merely Wi-Fi present. SYNCING stays active until all concurrent requests finish, OFFLINE is unavailable network, SYNC ERROR is a transport/server failure (a malformed success is separately shown as a blocking contract error), AUTH ERROR requires sign-in, CHECKING has not yet verified backend. Connectivity callbacks may mark availability but cannot grant permissions.

No receipt outbox is enabled: no approved backend replay protocol exists. A small encrypted **mutation journal** records an in-flight physical receipt before dispatch so process death/lost response cannot silently repeat it. It is **not a queued request** and has no auto-sync/replay method. Aggregate quantities cannot prove which physical unit was accepted. Without an operation lookup endpoint an unresolved article receipt blocks further receipt mutations; a supervisor must reconcile/close the server session. See BC-01.

A successful article response is persisted as receipt evidence before success is rendered. It remains attached to the marker until the operator explicitly acknowledges physical placement/next unit. Recovery re-shows that recorded ArticleUnit without a new POST or success beep. This closes the response→UI/process-death gap; it is not an outbox or inferred receipt from tally. Logout clears local credentials before network revocation is attempted, while retaining this recovery evidence.

## Rollout / configuration

Use trusted `AYROVI_API_BASE_URL` / Gradle property for the existing HTTPS `/api` root. Show the selected host on sign-in. Do not embed secrets. Preserve the old endpoint as compatibility default only; its production revision is not certified.

Use `-PworkerLegacyFallback=true` only to build the frozen rollback experience **with the same application ID**, after an operator-approved rollback. No runtime switch exposes extra roles/actions. Default native work is a migration pilot, not automatic production rollout. Keep release unsigned unless the organization's secure signing process supplies its key; never use the debug key for production. No automatic rolling release deletion/publication.

## Verification

Core state-machine/transport tests run on JVM; scanner rules run in existing scanner-core; Android compile/lint and UI/instrumentation are distinct gates. Test fixtures live in test sources only. No production mock repository, fabricated task counts or static workflow data. Physical testing cannot be substituted by JVM/Compose/emulator evidence.
