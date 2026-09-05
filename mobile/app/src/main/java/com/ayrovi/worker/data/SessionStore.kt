package com.ayrovi.worker.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID
import kotlinx.serialization.json.Json

/** Keystore-backed sessions + durable stop marker. NO plaintext token or journal fallback. */
class SessionStore(context: Context, storageName: String = FILE) : SessionStorage, MutationJournal {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    // Previous releases could fall back to raw preferences in the same file. Purge credentials
    // even if Keystore initialization subsequently fails; do NOT import plaintext credentials.
    private val raw = context.applicationContext.getSharedPreferences(storageName, Context.MODE_PRIVATE)
    private val legacyDevice = raw.getString(KEY_DEVICE, null)
    init {
        check(raw.edit().remove(KEY_ACCESS).remove(KEY_REFRESH).remove(KEY_EMPLOYEE).commit()) {
            "Legacy credentials could not be removed. Secure startup is blocked."
        }
        check(!raw.contains(KEY_PENDING)) { "Unrecognized recovery data requires supervisor reconciliation." }
    }
    private val prefs = EncryptedSharedPreferences.create(
        context.applicationContext, storageName,
        MasterKey.Builder(context.applicationContext).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    private var version = 0L
    private var identityVersion = 0L

    init {
        val secureDevice = prefs.getString(KEY_DEVICE, null)
        if (!legacyDevice.isNullOrBlank()) {
            check(secureDevice == null || secureDevice == legacyDevice) { "Conflicting device identities require administrator verification." }
            if (secureDevice == null) check(prefs.edit().putString(KEY_DEVICE, legacyDevice).commit()) { "Secure device migration failed." }
            check(raw.edit().remove(KEY_DEVICE).commit()) { "Legacy identity cleanup failed." }
        }
        snapshot()
        read() // Corrupt encrypted recovery data locks startup, never becomes an empty journal.
    }

    override val deviceCode: String
        @Synchronized get() {
            prefs.getString(KEY_DEVICE, null)?.let { return it }
            val code = "AYROVI-" + UUID.randomUUID().toString().replace("-", "").take(16).uppercase()
            check(prefs.edit().putString(KEY_DEVICE, code).commit()) { "Secure device identity could not be saved." }
            return code
        }

    override var employeeCode: String?
        @Synchronized get() = prefs.getString(KEY_EMPLOYEE, null)
        @Synchronized set(value) {
            check(prefs.edit().putString(KEY_EMPLOYEE, value).commit()) { "Secure worker identity could not be saved." }
        }

    @Synchronized override fun snapshot(): SessionSnapshot {
        val access = prefs.getString(KEY_ACCESS, null)
        val refresh = prefs.getString(KEY_REFRESH, null)
        val tokens = if (!access.isNullOrBlank() && !refresh.isNullOrBlank()) AuthTokens(access, refresh) else null
        return SessionSnapshot(version, tokens, identityVersion)
    }

    @Synchronized override fun replace(expectedVersion: Long, tokens: AuthTokens, newLogin: Boolean): Boolean {
        if (version != expectedVersion) return false
        check(tokens.accessToken.isNotBlank() && tokens.refreshToken.isNotBlank())
        check(prefs.edit().putString(KEY_ACCESS, tokens.accessToken).putString(KEY_REFRESH, tokens.refreshToken).commit()) { "Secure session could not be saved." }
        version++
        if (newLogin) identityVersion++
        return true
    }

    @Synchronized override fun clear() {
        // Retain stable device identity, encryption metadata AND unresolved operation.
        check(prefs.edit().remove(KEY_ACCESS).remove(KEY_REFRESH).remove(KEY_EMPLOYEE).commit()) { "Secure session could not be cleared." }
        version++; identityVersion++
    }
    @Synchronized override fun clearIfVersion(expectedVersion: Long): Boolean {
        if (version != expectedVersion) return false
        clear(); return true
    }
    @Synchronized override fun clearIfIdentity(expectedIdentity: Long): Boolean {
        if (identityVersion != expectedIdentity) return false
        clear(); return true
    }

    @Synchronized override fun read(): PendingMutation? = prefs.getString(KEY_PENDING, null)?.let {
        json.decodeFromString(PendingMutation.serializer(), it)
    }
    @Synchronized override fun record(mutation: PendingMutation) {
        val existing = read()
        check(existing == null || existing.id == mutation.id) { "An earlier operation still requires reconciliation." }
        check(prefs.edit().putString(KEY_PENDING, json.encodeToString(PendingMutation.serializer(), mutation)).commit()) {
            "The operation could not be safely recorded on this device. Nothing was sent."
        }
    }
    @Synchronized override fun clear(id: String) {
        if (read()?.id == id) check(prefs.edit().remove(KEY_PENDING).commit()) { "Operation recovery could not be saved." }
    }

    companion object {
        private const val FILE = "ayrovi_worker_secure"
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_EMPLOYEE = "employee_code"
        private const val KEY_DEVICE = "device_code"
        private const val KEY_PENDING = "unresolved_mutation_v1"
    }
}
