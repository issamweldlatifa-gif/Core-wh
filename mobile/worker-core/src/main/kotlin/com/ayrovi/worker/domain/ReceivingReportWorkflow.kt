package com.ayrovi.worker.domain

import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.data.ReceivingReportView
import com.ayrovi.worker.data.ReportPhotoInput
import com.ayrovi.worker.data.WorkerRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * CONFIRMATION REPORT (ORDER 01 verification report) — worker state machine.
 *
 * The HOME feed is session-less (the backend auto-resolves scans), so the
 * report resolves the worker's open receiving session itself: first arrival
 * with a non-null active session. All mutations reload the view; a locked
 * report (SUBMITTED/REVIEWED/CLOSED) disables every mutation.
 */
data class ReceivingReportState(
    val loading: Boolean = true,
    val authorized: Boolean = false,
    val sessionId: String? = null,
    val report: ReceivingReportView? = null,
    val message: OperationalMessage? = null,
    val authExpired: Boolean = false,
    val noSession: Boolean = false,
    val justSubmitted: Boolean = false,
) {
    val reportStatus: String get() = report?.reportStatus ?: "NONE"
    val locked: Boolean
        get() = reportStatus == "SUBMITTED" || reportStatus == "REVIEWED" || reportStatus == "CLOSED"
    val canMutate: Boolean get() = authorized && !loading && report != null && !locked && !noSession
    val sessionCode: String? get() = report?.session?.code
    val arrivalCode: String? get() = report?.arrival?.code
}

class ReceivingReportWorkflow(
    private val gateway: ReceivingGateway,
    permissions: Set<String>,
    private val scope: CoroutineScope,
) {
    private var permissions = permissions
    private val mutable = MutableStateFlow(
        ReceivingReportState(authorized = requiredPermissions.all { it in permissions }),
    )
    val state: StateFlow<ReceivingReportState> = mutable.asStateFlow()
    private val _events = MutableSharedFlow<OperationalMessage>(extraBufferCapacity = 1)
    val events: SharedFlow<OperationalMessage> = _events.asSharedFlow()

    fun updateAccess(permissions: Set<String>) {
        this.permissions = permissions
        mutable.update { it.copy(authorized = requiredPermissions.all(permissions::contains)) }
    }

    fun initialize() {
        scope.launch {
            mutable.update { it.copy(loading = true, message = null, noSession = false, justSubmitted = false) }
            try {
                val found = resolveSession()
                if (found == null) {
                    mutable.update { it.copy(loading = false, noSession = true) }
                    return@launch
                }
                mutable.update { it.copy(sessionId = found) }
                load(found)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                fail(failure)
            }
        }
    }

    /**
     * ORDER 04 — resolve the reportable session with ONE call. The direct
     * endpoint answers immediately; only older backends (404) fall through to
     * the legacy arrivals + per-arrival probe loop. A failure of one probe
     * never aborts the resolution — but cancellation is never swallowed.
     */
    private suspend fun resolveSession(): String? {
        try {
            gateway.activeReceivingSession()?.let { return it.id }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Older backend (or a transient failure of the direct call):
            // fall through to the legacy loop below.
        }
        for (arrival in gateway.arrivals()) {
            val code = arrival.code ?: continue
            val active = try {
                gateway.activeSession(code)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            if (active != null) return active.id
        }
        return null
    }

    fun refresh() {
        val id = mutable.value.sessionId ?: return initialize()
        scope.launch {
            mutable.update { it.copy(loading = true, message = null) }
            try {
                load(id)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                fail(failure)
            }
        }
    }

    fun saveDraft(description: String?, observation: String?, photos: List<ReportPhotoInput>) {
        val id = mutable.value.sessionId ?: return
        if (!mutable.value.canMutate || photos.size > MAX_PHOTOS) return
        scope.launch {
            mutable.update { it.copy(loading = true, message = null, justSubmitted = false) }
            try {
                val view = gateway.saveReportDraft(id, description, observation, photos)
                val done = OperationalMessage(
                    "DRAFT SAVED", "Your description and photos are saved.", MessageTone.SUCCESS,
                )
                mutable.update { it.copy(loading = false, report = view, message = done) }
                _events.tryEmit(done)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                fail(failure)
            }
        }
    }

    fun damage(lineId: String, quantity: Int, note: String?) {
        val id = mutable.value.sessionId ?: return
        if (!mutable.value.canMutate || quantity < 1) return
        scope.launch {
            mutable.update { it.copy(loading = true, message = null) }
            try {
                gateway.markDamage(id, lineId, quantity, note)
                load(id)
                val done = OperationalMessage(
                    "DAMAGE RECORDED", "Damaged units updated on this product.", MessageTone.SUCCESS,
                )
                mutable.update { it.copy(message = done) }
                _events.tryEmit(done)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                fail(failure)
            }
        }
    }

    fun submit(description: String?, observation: String?, photos: List<ReportPhotoInput>) {
        val id = mutable.value.sessionId ?: return
        if (!mutable.value.canMutate || photos.size > MAX_PHOTOS) return
        scope.launch {
            mutable.update { it.copy(loading = true, message = null) }
            try {
                gateway.submitReport(id, description, observation, photos)
                // The report is sent AND STAYS VISIBLE: the submitted view
                // is re-read from the server (SUBMITTED = locked/read-only),
                // so the worker still sees the backend data (session,
                // arrival, totals, lines) — nothing is wiped from this
                // device. Wiping here was a field-reported bug: the rapport
                // page carries backend/admin data that must remain visible
                // after sending. (The wipe was device-local only — the
                // backend always kept everything — but it wrongly hid the
                // submitted report from the worker.)
                load(id)
                val done = OperationalMessage(
                    "REPORT SENT", "The report was sent and locked. The submitted report stays visible below.", MessageTone.SUCCESS,
                )
                mutable.update { it.copy(loading = false, message = done, justSubmitted = true) }
                _events.tryEmit(done)
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                fail(failure)
            }
        }
    }

    fun dismissMessage() {
        mutable.update { it.copy(message = null) }
    }

    private suspend fun load(sessionId: String) {
        val view = gateway.report(sessionId)
        mutable.update { it.copy(loading = false, report = view, noSession = false) }
    }

    private fun fail(failure: Exception) {
        if (failure is WorkerRepository.ApiException && failure.code == 401) {
            mutable.update { it.copy(loading = false, authExpired = true) }
            _events.tryEmit(WorkerMessages.api(401, failure.message, false))
            return
        }
        val message = failure.toOperationalMessage()
        mutable.update { it.copy(loading = false, message = message) }
        _events.tryEmit(message)
    }

    companion object {
        const val MAX_PHOTOS = 10
        private val requiredPermissions = setOf(WorkerAccess.VIEW_RECEIVING, WorkerAccess.EXECUTE_RECEIVING)
    }
}
