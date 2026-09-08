package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.WorkerSessionUseCase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlin.test.*

class WorkerSessionUseCaseTest {
    private val json = Json { encodeDefaults = true }
    private val worker = MeResponse(user = MeUser(id = "worker"), application = "WORKER_NATIVE",
        allowedApplications = listOf("WORKER_NATIVE"), permissions = listOf("receiving.view", "receiving.execute"))
    private val context = TerminalContext(worker = WorkerRef("worker"), readyTaskCount = 99,
        tasks = listOf(TerminalTask(key = "receiving", ready = true, permission = "receiving.execute")))

    private class Responses(val values: Map<String, String>) : WorkerTransport {
        val paths = mutableListOf<String>()
        override val connection = MutableStateFlow(ConnectionState.ONLINE)
        override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String {
            paths += path
            return values.getValue(path)
        }
        override fun networkAvailable(available: Boolean) {}
    }
    private fun responses(me: MeResponse = worker, terminal: TerminalContext = context) = Responses(mapOf(
        "/v1/auth/me" to json.encodeToString(MeResponse.serializer(), me),
        "/v1/terminal/context" to json.encodeToString(TerminalContext.serializer(), terminal),
        "/v1/terminal/work" to "[]",
        "/v1/terminal/assignments" to """{"open":[],"recent":[]}""",
        "/v1/receiving/home" to """{"productCardsPending":2,"cartonCardsPending":1}""",
    ))
    @Test fun `work context counts only cards from the worker scoped home feed`() = runBlocking {
        val store = MemorySessions().apply { signIn() }
        val result = WorkerSessionUseCase(WorkerRepository(store, responses()), store).loadContext()
        assertEquals(3, result.receivingArrivalCount)
        assertEquals(1, result.tasks.size)
        assertEquals(99, result.context.readyTaskCount)
        assertEquals(store.snapshot().identityVersion, result.identityVersion)
    }
    @Test fun `worker without receiving read authority does not query receiving queue`() = runBlocking {
        val store = MemorySessions().apply { signIn() }
        val transport = responses(worker.copy(permissions = listOf("picking.execute")))
        val result = WorkerSessionUseCase(WorkerRepository(store, transport), store).loadContext()
        assertNull(result.receivingArrivalCount)
        assertFalse(transport.paths.contains("/v1/receiving/arrivals"))
        assertTrue(result.tasks.isEmpty())
    }
    @Test fun `admin surface response fails closed`() = runBlocking {
        val store = MemorySessions().apply { signIn() }
        val useCase = WorkerSessionUseCase(WorkerRepository(store, responses(worker.copy(application = "ADMIN_WEB"))), store)
        assertEquals(401, assertFailsWith<WorkerRepository.ApiException> { useCase.loadContext() }.code)
        assertFalse(store.hasSession())
    }
    @Test fun `mismatched worker context cannot authorize a new actor`() = runBlocking {
        val store = MemorySessions().apply { signIn() }
        val transport = responses(terminal = context.copy(worker = WorkerRef("another-worker")))
        val useCase = WorkerSessionUseCase(WorkerRepository(store, transport), store)
        assertFailsWith<WorkerRepository.ApiException> { useCase.loadContext() }
        assertFalse(transport.paths.contains("/v1/terminal/assignments"))
        assertFalse(store.hasSession())
    }
    @Test fun `stale UI cannot sign out a newly authenticated worker`() {
        val store = MemorySessions().apply { signIn() }
        val useCase = WorkerSessionUseCase(WorkerRepository(store, responses()), store)
        val oldIdentity = store.snapshot().identityVersion
        store.signIn("new-worker", "new-refresh")
        assertFalse(useCase.expire(oldIdentity))
        assertEquals("new-worker", store.accessToken())
    }
    @Test fun `missing server quantities are a contract error not zero stock`() {
        assertFailsWith<SerializationException> {
            json.decodeFromString(ReceivingSession.serializer(), """{"id":"s","code":"RCV-1","status":"RECEIVING","startedAt":"2026-09-05T08:00:00Z"}""")
        }
        assertFailsWith<SerializationException> { json.decodeFromString(ReceivingTally.serializer(), "{}") }
    }
}
