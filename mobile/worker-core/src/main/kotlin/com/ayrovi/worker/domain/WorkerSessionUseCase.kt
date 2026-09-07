package com.ayrovi.worker.domain

import com.ayrovi.worker.data.*
import kotlinx.coroutines.CancellationException

/** Backend-verified operational identity and queue, independent of Android/Compose lifecycle. */
data class WorkerContextSnapshot(
    val me: MeResponse,
    val context: TerminalContext,
    val tasks: List<TerminalTask>,
    val assignments: AssignmentsResponse,
    val receivingArrivalCount: Int?,
    val identityVersion: Long,
    val workCounts: List<WorkCount> = emptyList(),
    /**
     * Live per-lane pending counters from GET /receiving/home, refreshed on
     * every context poll when this worker holds receiving access. They power
     * the whole-app "new card" tray notification on ANY screen (Home queue
     * included), not only while the Receiving screen is open. Null when the
     * worker has no receiving access or the feed was unavailable on this poll.
     */
    val receivingProductPending: Int? = null,
    val receivingCartonPending: Int? = null,
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
        // Per-lane card counters for the whole-app new-card notification. Read
        // alone so a transient feed failure never blocks the rest of the context.
        val canWatchCards = WorkerAccess.VIEW_RECEIVING in me.permissions && WorkerAccess.EXECUTE_RECEIVING in me.permissions
        val home: ReceivingHome? = if (!canWatchCards) null else try {
            repository.receivingHome()
        } catch (cancelled: CancellationException) {
            throw cancelled // never swallow cancellation in a coroutine
        } catch (failure: Exception) {
            null // feed unavailable on this poll; retried on the next one
        }
        if (store.snapshot().identityVersion != identity) throw SessionChangedFailure(false)
        return WorkerContextSnapshot(
            me = me,
            context = context,
            tasks = WorkerAccess.permittedTasks(me, context),
            assignments = assignments,
            receivingArrivalCount = count,
            identityVersion = identity,
            workCounts = counts,
            receivingProductPending = home?.productCardsPending,
            receivingCartonPending = home?.cartonCardsPending,
        )
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
