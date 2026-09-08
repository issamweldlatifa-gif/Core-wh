# Worker push notifications — activation guide

New receiving cards are pushed from the backend to every worker holding the
`receiving.execute` permission, so the notification arrives whether the Worker
App is **open, backgrounded or completely closed**.

The whole pipeline is implemented and unit-tested. Two credential-dependent
steps remain, and they cannot be performed from this workspace because they
require your Firebase project.

## What is already in place

| Piece | Location |
| --- | --- |
| Token storage | `push_tokens` table (migration `20260908160000_worker_push_tokens`) |
| Register / unregister API | `POST` and `DELETE /v1/notifications/push-token` |
| Audience resolution (by permission) | `PushService.notifyTaskAudience()` |
| `NEW_RECEIVING_CARD` event | emitted after CRM intake commits |
| Android receiver (works when closed) | `app/.../push/AyroviMessagingService.kt` |
| Notification channel + deep link | same file → opens `/terminal/receiving` |

## Step 1 — add the Firebase config to the app

1. In the Firebase console create (or open) the AYROVI project.
2. Add an Android app with the package id `com.ayrovi.worker`.
3. Download `google-services.json` into `mobile/app/`.
4. Enable the Google Services plugin — it is intentionally **not** enabled
   today, because it fails the build when the JSON file is missing:

   ```kotlin
   // mobile/build.gradle.kts  (root, plugins block)
   id("com.google.gms.google-services") version "4.4.2" apply false

   // mobile/app/build.gradle.kts (plugins block)
   id("com.google.gms.google-services")
   ```

Until this step is done the app compiles and runs normally; the messaging
service simply never receives anything.

## Step 2 — give the backend a sending credential

`PushService` sends through the `PushTransport` seam. The default
`LoggingPushTransport` logs the message instead of sending it, so the audience
logic is exercised without credentials.

To send for real, implement `PushTransport.send()` with the Firebase Admin SDK
and provide it in `notifications.module.ts`:

```ts
// npm i firebase-admin
const transport = process.env.FIREBASE_SERVICE_ACCOUNT
  ? new FcmPushTransport(process.env.FIREBASE_SERVICE_ACCOUNT)
  : new LoggingPushTransport();
```

`send()` must return the tokens FCM reports as `UNREGISTERED` /
`INVALID_ARGUMENT` in `invalidTokens`; `PushService` prunes them automatically
so the table cannot fill up with dead handsets.

> Send **data** messages, not `notification` payloads. A `notification`
> payload is handled by the system tray when the app is backgrounded and the
> app's own handler never runs — which would give two divergent notification
> paths. Data messages keep exactly one.

## Verifying the three required states

Once both steps are done:

```bash
# Trigger a card and watch the fan-out
curl -X POST https://<host>/v1/integration/arrivals -H 'Idempotency-Key: <fresh-uuid>' ...
```

* **TEST G — app open**: notification posted, Receiving queue refreshes.
* **TEST H — app background**: notification appears in the tray.
* **TEST I — app closed** (swipe it from recents): the OS starts
  `AyroviMessagingService` and the notification still appears.

Tapping the notification opens `MainActivity` (`singleTask`) with the
`ayrovi.route` extra set to `/terminal/receiving`.
