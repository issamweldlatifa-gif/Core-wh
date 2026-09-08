@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.domain.PushRegistration
import com.ayrovi.worker.domain.PushTokenStorage
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/**
 * The token must actually REACH the backend, otherwise NEW_RECEIVING_CARD has
 * no address to deliver to and the whole push feature is dead on arrival.
 */
private class FakeStorage(
    var token: String? = "tok-1",
    var synced: String? = null,
) : PushTokenStorage {
    override fun token(): String? = token
    override fun needsSync(): Boolean = token != null && token != synced
    override fun markSynced(token: String) { synced = token }
    override fun clearSynced() { synced = null }
}

class PushRegistrationTest {

    @Test fun `token is uploaded after login`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage()
        assertTrue(PushRegistration(backend, storage, "dev-1").syncAfterLogin())
        assertEquals(listOf("tok-1"), backend.registeredTokens)
        assertEquals("tok-1", storage.synced)
    }

    @Test fun `an unchanged token is not uploaded again on the next start`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage(synced = "tok-1")
        assertFalse(PushRegistration(backend, storage).syncAfterLogin())
        assertTrue(backend.registeredTokens.isEmpty(), "no redundant POST on every launch")
    }

    @Test fun `a refreshed token replaces the old one`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage(token = "tok-2", synced = "tok-1")
        assertTrue(PushRegistration(backend, storage).syncAfterLogin())
        assertEquals(listOf("tok-2"), backend.registeredTokens)
    }

    @Test fun `a failed upload is retried on the next start and never breaks login`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage()
        backend.pushFailure = RuntimeException("network down")

        // Must not throw — a push outage cannot block the worker from scanning.
        assertFalse(PushRegistration(backend, storage).syncAfterLogin())
        assertNull(storage.synced, "a failed upload must stay unsynced")

        // Next start succeeds.
        backend.pushFailure = null
        assertTrue(PushRegistration(backend, storage).syncAfterLogin())
        assertEquals(listOf("tok-1"), backend.registeredTokens)
    }

    @Test fun `nothing is uploaded when FCM has not issued a token yet`() = runTest {
        val backend = HomeBackend()
        assertFalse(PushRegistration(backend, FakeStorage(token = null)).syncAfterLogin())
        assertTrue(backend.registeredTokens.isEmpty())
    }

    @Test fun `logout releases the token so a signed-out phone stops receiving cards`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage(synced = "tok-1")
        assertTrue(PushRegistration(backend, storage).releaseOnLogout())
        assertEquals(listOf("tok-1"), backend.unregisteredTokens)
        assertNull(storage.synced)
    }

    @Test fun `a failed logout still clears local state so the next login re-registers`() = runTest {
        val backend = HomeBackend()
        val storage = FakeStorage(synced = "tok-1")
        backend.pushFailure = RuntimeException("offline")
        assertFalse(PushRegistration(backend, storage).releaseOnLogout())
        assertNull(storage.synced)

        backend.pushFailure = null
        assertTrue(PushRegistration(backend, storage).syncAfterLogin(), "re-registers on next login")
    }
}
