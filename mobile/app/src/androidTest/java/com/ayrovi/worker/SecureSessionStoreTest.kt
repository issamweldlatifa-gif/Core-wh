package com.ayrovi.worker

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.data.*
import java.io.File
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated preference namespace. Never touches an installed worker's real session/journal. */
@RunWith(AndroidJUnit4::class)
class SecureSessionStoreTest {
    private lateinit var context: Context
    private lateinit var file: String
    @Before fun setup() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        file = "worker_security_test_${UUID.randomUUID()}"
    }
    @After fun cleanup() { context.deleteSharedPreferences(file) }

    @Test fun logoutKeepsStableDeviceAndUnresolvedMutationButNoTokens() {
        val store = SessionStore(context, file)
        val device = store.deviceCode
        store.replace(store.snapshot().version, AuthTokens("test-access", "test-refresh"), newLogin = true)
        store.employeeCode = "test-worker"
        val pending = PendingMutation("operation", "test-worker", MutationKind.RECEIVE_ARTICLE, "session", subject = "SKU", createdAt = 1)
        store.record(pending)
        store.clear()
        val restored = SessionStore(context, file)
        assertFalse(restored.hasSession())
        assertNull(restored.employeeCode)
        assertEquals(device, restored.deviceCode)
        assertEquals(pending, restored.read())
    }
    @Test fun credentialsAndMutationAreNotWrittenAsPlaintext() {
        val store = SessionStore(context, file)
        store.replace(store.snapshot().version, AuthTokens("sensitive-test-access", "sensitive-test-refresh"), newLogin = true)
        store.record(PendingMutation("sensitive-operation-marker", "worker", MutationKind.RECEIVE_ARTICLE, createdAt = 1))
        val xml = File(context.applicationInfo.dataDir, "shared_prefs/$file.xml").readText()
        assertFalse(xml.contains("sensitive-test-access"))
        assertFalse(xml.contains("sensitive-test-refresh"))
        assertFalse(xml.contains("sensitive-operation-marker"))
    }
    @Test fun upgradePurgesLegacyPlaintextTokensButPreservesDeviceCode() {
        val raw = context.getSharedPreferences(file, Context.MODE_PRIVATE)
        assertTrue(raw.edit().putString("access_token", "old-plaintext-access")
            .putString("refresh_token", "old-plaintext-refresh")
            .putString("employee_code", "old-worker")
            .putString("device_code", "AYROVI-LEGACY1").commit())
        val upgraded = SessionStore(context, file)
        assertFalse(upgraded.hasSession())
        assertEquals("AYROVI-LEGACY1", upgraded.deviceCode)
        assertFalse(raw.contains("access_token"))
        assertFalse(raw.contains("refresh_token"))
        assertFalse(raw.contains("employee_code"))
        assertFalse(raw.contains("device_code"))
    }
    @Test fun confirmedReceiptEvidenceSurvivesReopenUntilAcknowledged() {
        val store = SessionStore(context, file)
        val pending = PendingMutation("confirmed-operation", "test-worker", MutationKind.RECEIVE_ARTICLE, "session", createdAt = 1,
            confirmedReceipt = ConfirmedReceipt("ART-TEST", "SKU-TEST", "RCN-TEST", false))
        store.record(pending)
        val restored = SessionStore(context, file)
        assertEquals(pending, restored.read())
        restored.clear(pending.id)
        assertNull(SessionStore(context, file).read())
    }
    @Test fun staleRefreshCannotRestoreASignedOutSession() {
        val store = SessionStore(context, file)
        val previous = store.snapshot()
        store.clear()
        assertFalse(store.replace(previous.version, AuthTokens("late-token", "late-refresh")))
        assertFalse(store.hasSession())
    }
}
