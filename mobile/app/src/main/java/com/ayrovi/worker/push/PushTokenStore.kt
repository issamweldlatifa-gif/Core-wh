package com.ayrovi.worker.push

import android.content.Context

/**
 * Holds the FCM token between "Firebase issued it" and "we have a session to
 * upload it with".
 *
 * onNewToken can fire before the worker logs in, so the token is parked here
 * and flushed to the backend on the next authenticated start. `syncedToken`
 * records what the server already knows, so a normal app start does not
 * re-POST an unchanged token on every launch.
 */
class PushTokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("ayrovi_push", Context.MODE_PRIVATE)

    fun save(token: String) = prefs.edit().putString(KEY_TOKEN, token).apply()

    fun token(): String? = prefs.getString(KEY_TOKEN, null)

    /** True when the token still needs uploading to the backend. */
    fun needsSync(): Boolean {
        val current = token() ?: return false
        return current != prefs.getString(KEY_SYNCED, null)
    }

    fun markSynced(token: String) = prefs.edit().putString(KEY_SYNCED, token).apply()

    /** Logout: the token stays valid for the device but is no longer ours to send. */
    fun clearSynced() = prefs.edit().remove(KEY_SYNCED).apply()

    private companion object {
        const val KEY_TOKEN = "fcm_token"
        const val KEY_SYNCED = "fcm_token_synced"
    }
}
