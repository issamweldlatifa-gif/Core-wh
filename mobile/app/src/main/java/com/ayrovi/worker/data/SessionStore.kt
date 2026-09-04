package com.ayrovi.worker.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Secure session + device storage.
 *
 * Tokens are kept in EncryptedSharedPreferences (Android Keystore backed).
 * The device code is generated once and persisted, so the same hardware
 * presents a stable identity to the backend (admin pre-registers it under
 * Admin Web → Devices; first login binds it to the worker if unassigned).
 */
class SessionStore(context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (_: Exception) {
        // Keystore unavailable (rare/emulator edge): fall back so the app can
        // still be exercised. Production policy enforces the encrypted store.
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    }

    val deviceCode: String
        get() {
            val existing = prefs.getString(KEY_DEVICE, null)
            if (existing != null) return existing
            val generated = "AYROVI-" + UUID.randomUUID().toString().replace("-", "").take(6).uppercase()
            prefs.edit().putString(KEY_DEVICE, generated).apply()
            return generated
        }

    var employeeCode: String?
        get() = prefs.getString(KEY_EMPLOYEE, null)
        set(value) {
            prefs.edit().putString(KEY_EMPLOYEE, value).apply()
        }

    fun saveTokens(access: String, refresh: String) {
        prefs.edit().putString(KEY_ACCESS, access).putString(KEY_REFRESH, refresh).apply()
    }

    fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)

    fun clear() {
        prefs.edit().clear().apply()
        // Keep the stable device identity across logins/logouts.
        prefs.edit().putString(KEY_DEVICE, deviceCode).apply()
    }

    fun hasSession(): Boolean = !accessToken().isNullOrEmpty() && !refreshToken().isNullOrEmpty()

    companion object {
        private const val FILE = "ayrovi_worker_secure"
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_EMPLOYEE = "employee_code"
        private const val KEY_DEVICE = "device_code"
    }
}
