package com.ayrovi.worker.domain

import com.ayrovi.worker.data.*

/** Backend-verified operational identity and queue, independent of Android/Compose lifecycle. */
data class WorkerContextSnapshot(
    val me: MeResponse,
    val context: TerminalContext,
    val tasks: List<TerminalTask>,
    val assignments: AssignmentsResponse,
    val receivingArrivalCount: Int?,
    val identityVersion: Long,
    val workCounts: List<WorkCount> = emptyList(),
)

class WorkerSessionUseCase(private val repository: WorkerRepository, private val store: SessionStorage) {
    val connection get() = repository.connection
    val deviceCode get() = store.deviceCode
    val hasSession get() = store.hasSession()

    suspend fun login(identifier: String, secret: String, pin: Boolean) {
        repository.login(identifier, secret, if (pin) "pin" else "password", deviceCode)
    }

    suspend fun loadContext(): WorkerContextSnapshot {
        val identity = store.snapshot().identityVersion
        val me = repository.me()
        if (!WorkerAccess.isWorkerSession(me)) denyIdentity(identity, "This session is not authorized for the Worker application.")
        val context = repository.terminalContext()
        if (context.worker?.id != me.user?.id) denyIdentity(identity, "Worker identity could not be verified.")
        val assignments = repository.assignments()
        val counts = repository.workCounts()
        val count = if (WorkerAccess.VIEW_RECEIVING in me.permissions && WorkerAccess.EXECUTE_RECEIVING in me.permissions)
            repository.arrivals().size else null
        if (store.snapshot().identityVersion != identity) throw SessionChangedFailure(false)
        return WorkerContextSnapshot(me, context, WorkerAccess.permittedTasks(me, context), assignments, count, identity, counts)
    }

    suspend fun completeAssignment(id: String): AssignmentsResponse {
        repository.completeAssignment(id) // This acknowledges an instruction, not a physical stock task.
        return repository.assignments()
    }
    suspend fun logout() = repository.logout()

    /** A stale UI must never sign out a newly authenticated worker. */
    fun expire(expectedIdentity: Long? = null): Boolean {
        val current = store.snapshot()
        if (current.tokens != null && expectedIdentity != null && current.identityVersion != expectedIdentity) return false
        if (current.tokens != null) store.clearIfIdentity(current.identityVersion)
        return true
    }

    private fun denyIdentity(identity: Long, reason: String): Nothing {
        if (!store.clearIfIdentity(identity)) throw SessionChangedFailure(false)
        throw WorkerRepository.ApiException(401, reason)
    }
}
