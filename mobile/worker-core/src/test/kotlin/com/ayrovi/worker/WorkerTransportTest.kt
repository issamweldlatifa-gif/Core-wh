package com.ayrovi.worker

import com.ayrovi.worker.data.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import kotlin.test.*

class WorkerTransportTest {
    private lateinit var server: MockWebServer
    private lateinit var store: MemorySessions
    private lateinit var transport: HttpWorkerTransport
    private lateinit var repository: WorkerRepository
    @BeforeEach fun setup() {
        server = MockWebServer().apply { start() }
        store = MemorySessions().apply { signIn() }
        transport = HttpWorkerTransport(server.url("/api").toString(), store, allowHttpForTests = true)
        repository = WorkerRepository(store, transport)
    }
    @AfterEach fun cleanup() { server.shutdown() }

    @Test fun `production enforces HTTPS and rejects URL credentials`() {
        assertFailsWith<IllegalArgumentException> { HttpWorkerTransport.production("http://example.test/api", store) }
        assertFailsWith<IllegalArgumentException> { HttpWorkerTransport.production("https://worker:password@example.test/api", store) }
    }
    @Test fun `login uses exact WORKER_NATIVE contract and no stale bearer header`() = runBlocking {
        store.clear()
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"accessToken":"test-access","refreshToken":"test-refresh"}"""))
        repository.login(" W001 ", "test-password", "password", "TEST-DEVICE")
        val request = server.takeRequest()
        assertEquals("/api/v1/auth/login", request.path)
        val body = request.body.readUtf8()
        assertTrue(body.contains("\"app\":\"WORKER_NATIVE\""))
        assertTrue(body.contains("\"deviceId\":\"TEST-DEVICE\""))
        assertFalse(body.contains("application"))
        assertNull(request.getHeader("Authorization"))
        assertEquals("test-access", store.accessToken())
        assertEquals("W001", store.employeeCode)
    }
    @Test fun `API error array preserves backend permission reason without refresh`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"message":["Missing receiving.execute","Station assignment required"]}"""))
        val failure = assertFailsWith<WorkerRepository.ApiException> { transport.request("GET", "/v1/terminal/context") }
        assertEquals("Missing receiving.execute\nStation assignment required", failure.message)
        assertEquals(1, server.requestCount)
        assertNotNull(store.snapshot().tokens)
        assertEquals(ConnectionState.ONLINE, transport.connection.value)
    }
    @Test fun `one definite 401 refreshes then retries protected request once`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("{}"))
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"accessToken":"new-access","refreshToken":"new-refresh"}"""))
        server.enqueue(MockResponse().setBody("[]"))
        assertEquals("[]", transport.request("GET", "/v1/receiving/arrivals"))
        assertEquals(3, server.requestCount)
        assertEquals("Bearer old-access", server.takeRequest().getHeader("Authorization"))
        assertEquals("/api/v1/auth/refresh", server.takeRequest().path)
        assertEquals("Bearer new-access", server.takeRequest().getHeader("Authorization"))
    }
    @Test fun `concurrent unauthorized calls share one refresh`() = runBlocking {
        val refreshes = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/v1/auth/refresh" -> {
                    refreshes.incrementAndGet()
                    MockResponse().setBody("""{"accessToken":"new-access","refreshToken":"new-refresh"}""")
                }
                request.getHeader("Authorization") == "Bearer old-access" -> MockResponse().setResponseCode(401)
                else -> MockResponse().setBody("[]")
            }
        }
        List(8) { async(Dispatchers.Default) { transport.request("GET", "/v1/receiving/arrivals") } }.awaitAll()
        assertEquals(1, refreshes.get())
        assertEquals("new-access", store.accessToken())
    }
    @Test fun `logout during refresh cannot resurrect credentials`() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = if (request.path == "/api/v1/auth/refresh") {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                MockResponse().setBody("""{"accessToken":"late-access","refreshToken":"late-refresh"}""")
            } else MockResponse().setResponseCode(401)
        }
        val call = async(Dispatchers.Default) { runCatching { transport.request("GET", "/v1/receiving/arrivals") } }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        store.clear(); release.countDown()
        assertIs<SessionChangedFailure>(call.await().exceptionOrNull())
        assertNull(store.snapshot().tokens)
        assertEquals(2, server.requestCount)
    }
    @Test fun `new login during refresh cannot be overwritten or used to retry previous worker command`() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = if (request.path == "/api/v1/auth/refresh") {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                MockResponse().setBody("""{"accessToken":"late-access","refreshToken":"late-refresh"}""")
            } else MockResponse().setResponseCode(401)
        }
        val call = async(Dispatchers.Default) { runCatching { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") } }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        store.signIn("other-worker", "other-refresh"); release.countDown()
        assertIs<SessionChangedFailure>(call.await().exceptionOrNull())
        assertEquals("other-worker", store.accessToken())
        assertEquals(2, server.requestCount)
    }
    @Test fun `late successful mutation after logout is ambiguous not a definite 401 refusal`() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); return MockResponse().setBody("{}")
            }
        }
        val call = async(Dispatchers.Default) { runCatching { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") } }
        assertTrue(entered.await(5, TimeUnit.SECONDS)); store.clear(); release.countDown()
        assertTrue(assertIs<SessionChangedFailure>(call.await().exceptionOrNull()).outcomeUnknown)
        assertEquals(1, server.requestCount)
    }
    @Test fun `same identity token rotation does not invalidate another successful request`() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); return MockResponse().setBody("{}")
            }
        }
        val call = async(Dispatchers.Default) { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        store.replace(store.snapshot().version, AuthTokens("rotated", "rotated-refresh"))
        release.countDown()
        assertEquals("{}", call.await())
    }
    @Test fun `connection remains SYNCING until all concurrent requests finish`() = runBlocking {
        val slowStarted = CountDownLatch(1); val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/v1/auth/me") { slowStarted.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
                return MockResponse().setBody("{}")
            }
        }
        val slow = async(Dispatchers.Default) { transport.request("GET", "/v1/auth/me") }
        assertTrue(slowStarted.await(5, TimeUnit.SECONDS))
        transport.request("GET", "/v1/terminal/context")
        assertEquals(ConnectionState.SYNCING, transport.connection.value)
        release.countDown(); slow.await()
        assertEquals(ConnectionState.ONLINE, transport.connection.value)
    }
    @Test fun `refresh rejection clears local auth with no second protected attempt`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"message":"Revoked refresh session"}"""))
        assertEquals(401, assertFailsWith<WorkerRepository.ApiException> { transport.request("GET", "/v1/auth/me") }.code)
        assertNull(store.snapshot().tokens)
        assertEquals(ConnectionState.AUTH_ERROR, transport.connection.value)
        assertEquals(2, server.requestCount)
    }
    @Test fun `lost POST response is never retried`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val failure = assertFailsWith<TransportFailure> { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") }
        assertTrue(failure.outcomeUnknown)
        assertEquals(1, server.requestCount)
        assertEquals(ConnectionState.SYNC_ERROR, transport.connection.value)
    }
    @Test fun `server 500 after write is ambiguous and not retried`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"message":"Internal server error"}"""))
        val failure = assertFailsWith<WorkerRepository.ApiException> { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") }
        assertTrue(failure.outcomeUnknown)
        assertEquals(1, server.requestCount)
    }
    @Test fun `503 Retry-After zero cannot make OkHttp replay a mutation`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0"))
        server.enqueue(MockResponse().setBody("{}"))
        val failure = assertFailsWith<WorkerRepository.ApiException> {
            transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}")
        }
        assertEquals(503, failure.code)
        assertTrue(failure.outcomeUnknown)
        assertEquals(1, server.requestCount)
    }
    @Test fun `offline preflight proves nothing was dispatched`() = runBlocking {
        transport.networkAvailable(false)
        val failure = assertFailsWith<TransportFailure> { transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}") }
        assertFalse(failure.outcomeUnknown)
        assertEquals(0, server.requestCount)
        assertEquals(ConnectionState.OFFLINE, transport.connection.value)
        transport.networkAvailable(true)
        assertEquals(ConnectionState.CHECKING, transport.connection.value)
    }
    @Test fun `redirect cannot send bearer to another host`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://different-host.example/api/v1/auth/me"))
        assertFailsWith<WorkerRepository.ApiException> { transport.request("GET", "/v1/auth/me") }
        assertEquals(1, server.requestCount)
    }
    @Test fun `proxy HTML is not rendered to operators`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>stack trace private data</html>"))
        val failure = assertFailsWith<WorkerRepository.ApiException> { transport.request("GET", "/v1/auth/me") }
        assertFalse(failure.message.contains("<html>"))
        assertFalse(failure.message.contains("stack trace"))
    }
    @Test fun `logout clears local session even if remote revocation failed`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(503))
        val device = store.deviceCode
        assertFalse(repository.logout())
        assertNull(store.snapshot().tokens)
        assertEquals(device, store.deviceCode)
        assertEquals(1, server.requestCount)
    }
    @Test fun `logout durably clears credentials before waiting for remote revocation`() = runBlocking {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        var bearer: String? = null
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                bearer = request.getHeader("Authorization")
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                return MockResponse().setBody("{\"success\":true}")
            }
        }
        val logout = async(Dispatchers.Default) { repository.logout() }
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        assertFalse(store.hasSession())
        assertEquals("Bearer old-access", bearer)
        release.countDown()
        assertTrue(logout.await())
    }
    @Test fun `unexpected redirect after a write is uncertain and never followed`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/api/v1/auth/me"))
        val failure = assertFailsWith<WorkerRepository.ApiException> {
            transport.request("POST", "/v1/fulfillment/receiving/sessions/s/scan-article", "{}")
        }
        assertTrue(failure.outcomeUnknown)
        assertEquals(1, server.requestCount)
    }
    @Test fun `path parameters cannot inject new path or query`() = runBlocking {
        server.enqueue(MockResponse().setBody("null"))
        repository.activeSession("A/B ?&é")
        assertEquals("/api/v1/receiving/arrivals/A%2FB%20%3F%26%C3%A9/active", server.takeRequest().path)
    }
    @Test fun `token diagnostics are redacted`() {
        assertFalse(AuthTokens("secret-access", "secret-refresh").toString().contains("secret-"))
        assertFalse(SessionSnapshot(1, AuthTokens("secret-access", "secret-refresh")).toString().contains("secret-"))
    }
}
