package com.ayrovi.worker.domain

import com.ayrovi.worker.data.ReceivingGateway

/**
 * Uploads the device's push token to the backend.
 *
 * WHY THIS EXISTS: FCM can issue a token before anyone has logged in, so the
 * token is parked on the device and flushed on the next authenticated start.
 * Without this step the backend has no address for the handset and
 * NEW_RECEIVING_CARD reaches nobody — the token would sit in local storage
 * forever.
 *
 * Kept in worker-core (pure JVM, no Android imports) so the rules are unit
 * tested; the Android layer only supplies the storage.
 *
 * Rules:
 *  - never upload the same token twice (avoid a POST on every app start)
 *  - a failed upload must NOT be marked synced, so it retries next start
 *  - a failure must never break login: the worker can still scan without push
 */
interface PushTokenStorage {
    fun token(): String?
    fun needsSync(): Boolean
    fun markSynced(token: String)
    fun clearSynced()
}

class PushRegistration(
    private val gateway: ReceivingGateway,
    private val storage: PushTokenStorage,
    private val deviceId: String? = null,
) {
    /** Called after a session is established. Returns true when an upload happened. */
    suspend fun syncAfterLogin(): Boolean {
        val token = storage.token() ?: return false
        if (!storage.needsSync()) return false
        return try {
            gateway.registerPushToken(token, "ANDROID", deviceId)
            storage.markSynced(token)
            true
        } catch (failure: Exception) {
            // Left unsynced on purpose -> retried on the next start.
            false
        }
    }

    /** Called on logout so a signed-out handset stops receiving cards. */
    suspend fun releaseOnLogout(): Boolean {
        val token = storage.token() ?: return false
        return try {
            gateway.unregisterPushToken(token)
            storage.clearSynced()
            true
        } catch (failure: Exception) {
            // The session is going away regardless; clear locally so the next
            // login re-registers rather than assuming the server still knows.
            storage.clearSynced()
            false
        }
    }
}
