package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import kotlin.test.*

class WorkerPolicyTest {
    private fun me(permissions: List<String>) = MeResponse(user = MeUser(id = "w"), application = "WORKER_NATIVE",
        allowedApplications = listOf("WORKER_NATIVE"), permissions = permissions)
    private val receiving = TerminalTask(key = "receiving", ready = true, permission = "receiving.execute")
    private fun context(vararg tasks: TerminalTask) = TerminalContext(worker = WorkerRef("w"), tasks = tasks.toList(), readyTaskCount = 99)

    @Test fun `receiving needs both view and execution permissions`() {
        assertTrue(WorkerAccess.visibleTasks(me(listOf("receiving.execute")), context(receiving)).isEmpty())
        assertTrue(WorkerAccess.visibleTasks(me(listOf("receiving.view")), context(receiving)).isEmpty())
        assertEquals(listOf(receiving), WorkerAccess.visibleTasks(me(listOf("receiving.view", "receiving.execute")), context(receiving)))
    }
    @Test fun `role label never grants an action`() {
        val supervisor = me(emptyList()).copy(roles = listOf("SUPERVISOR"))
        assertTrue(WorkerAccess.visibleTasks(supervisor, context(receiving)).isEmpty())
    }
    @Test fun `admin web session is not a worker session`() {
        assertFalse(WorkerAccess.isWorkerSession(me(emptyList()).copy(application = "ADMIN_WEB")))
        assertFalse(WorkerAccess.isWorkerSession(me(emptyList()).copy(allowedApplications = listOf("ADMIN_WEB"))))
    }
    @Test fun `unknown permission and mismatched worker context deny by default`() {
        val worker = me(listOf("receiving.view", "receiving.execute"))
        assertTrue(WorkerAccess.visibleTasks(worker, context(receiving.copy(permission = null))).isEmpty())
        assertTrue(WorkerAccess.visibleTasks(worker, context(receiving).copy(worker = WorkerRef("another-worker"))).isEmpty())
        assertTrue(WorkerAccess.visibleTasks(worker, context(receiving.copy(ready = false))).isEmpty())
    }
    @Test fun `module count cannot produce an invented task count`() {
        val worker = me(listOf("receiving.view", "receiving.execute"))
        assertEquals(1, WorkerAccess.visibleTasks(worker, context(receiving, receiving)).size)
    }
    @Test fun `only draft input and scan cancellation are safe offline`() {
        assertTrue(OfflinePolicy.mayExecuteOffline(WorkerOperation.EDIT_DRAFT))
        assertTrue(OfflinePolicy.mayExecuteOffline(WorkerOperation.CANCEL_SCAN))
        WorkerOperation.entries.filter { it !in setOf(WorkerOperation.EDIT_DRAFT, WorkerOperation.CANCEL_SCAN) }.forEach {
            assertFalse(OfflinePolicy.mayExecuteOffline(it), it.name)
        }
    }
    @Test fun `missing workflows retain unknown offline authority`() {
        listOf(WorkerOperation.PICK, WorkerOperation.COUNT, WorkerOperation.RETURN).forEach {
            assertEquals(OfflineClass.UNKNOWN, OfflinePolicy.classify(it))
        }
    }
    @Test fun `session rotations preserve identity while login and logout break it`() {
        val sessions = MemorySessions().apply { signIn() }
        val first = sessions.snapshot()
        sessions.replace(first.version, AuthTokens("rotated", "refresh"))
        assertEquals(first.identityVersion, sessions.snapshot().identityVersion)
        sessions.signIn("new-worker", "refresh")
        assertNotEquals(first.identityVersion, sessions.snapshot().identityVersion)
        assertFalse(sessions.clearIfIdentity(first.identityVersion))
        assertEquals("new-worker", sessions.accessToken())
        sessions.clear()
        assertNull(sessions.accessToken())
    }
}
