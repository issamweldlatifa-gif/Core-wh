package com.ayrovi.worker

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class WorkerSessionStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "worker_session",
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun save(tokens: AuthTokens) {
        prefs.edit()
            .putString("access_token", tokens.accessToken)
            .putString("refresh_token", tokens.refreshToken)
            .apply()
    }

    fun accessToken(): String? = prefs.getString("access_token", null)

    fun refreshToken(): String? = prefs.getString("refresh_token", null)

    fun clear() { prefs.edit().clear().apply() }
}
