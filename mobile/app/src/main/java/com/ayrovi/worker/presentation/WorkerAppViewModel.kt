package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.WorkerSessionUseCase
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.WorkerQueuePolicy
import com.ayrovi.worker.domain.toOperationalMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Authentication/context state is lifecycle-owned, never created inside a Compose click callback. */
data class WorkerAppState(
    val signedIn: Boolean = false,
    val loginGeneration: Long = 0,
    val identityVersion: Long? = null,
    val busy: Boolean = false,
    val verified: Boolean = false,
    val storageLocked: Boolean = false,
    val me: MeResponse? = null,
    val context: TerminalContext? = null,
    val tasks: List<TerminalTask> = emptyList(),
    val assignments: AssignmentsResponse? = null,
    val receivingArrivals: Int? = null,
    val message: OperationalMessage? = null,
) {
    val queueItems get() = WorkerQueuePolicy.items(tasks, receivingArrivals)
}

class WorkerAppViewModel(private val session: WorkerSessionUseCase, private val audio: AudioFeedback = AudioFeedback.Silent) : ViewModel() {
    private val mutable = MutableStateFlow(WorkerAppState(signedIn = session.hasSession))
    val state = mutable.asStateFlow()
    val connection = session.connection
    val deviceCode = session.deviceCode
    private var generation = 0L
    private var explicitSignOut = false
    private var foreground = false
    private var monitor: Job? = null

    init {
        viewModelScope.launch {
            connection.collect { status ->
                if (status == ConnectionState.AUTH_ERROR && !session.hasSession) expireSession()
                if (status == ConnectionState.OFFLINE) mutable.update { it.copy(verified = false) }
                if (status == ConnectionState.CHECKING && foreground && !explicitSignOut && session.hasSession) refresh()
            }
        }
    }

    fun onForeground() {
        foreground = true
        monitor?.cancel()
        monitor = viewModelScope.launch {
            while (isActive) { if (!explicitSignOut && session.hasSession) refresh(); delay(30_000) }
        }
    }

    fun onBackground() {
        foreground = false
        monitor?.cancel()
        mutable.update { it.copy(verified = false) }
    }

    fun login(identifier: String, secret: String, pin: Boolean) {
        if (mutable.value.busy || mutable.value.storageLocked) return
        if (identifier.isBlank() || secret.isBlank()) {
            mutable.update { it.copy(message = OperationalMessage("SIGN-IN DETAILS REQUIRED", "Enter your employee code and password or PIN.")) }
            return
        }
        mutable.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                session.login(identifier, secret, pin)
                explicitSignOut = false
                mutable.update { it.copy(signedIn = true, loginGeneration = ++generation) }
                loadContext()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fail(failure) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }

    fun refresh() {
        if (mutable.value.busy || explicitSignOut || !session.hasSession) return
        mutable.update { it.copy(busy = true, verified = false, message = null) }
        viewModelScope.launch {
            try { loadContext() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fail(failure) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }

    private suspend fun loadContext() {
        val previous = mutable.value.receivingArrivals
        val verified = session.loadContext()
        val incoming = verified.receivingArrivalCount
        if (foreground && previous != null && incoming != null && incoming > previous) runCatching { audio.notification() }
        mutable.update { it.copy(
            signedIn = true, me = verified.me, context = verified.context, tasks = verified.tasks,
            assignments = verified.assignments, receivingArrivals = verified.receivingArrivalCount,
            identityVersion = verified.identityVersion, verified = foreground, message = null,
        ) }
    }

    fun completeAssignment(id: String) {
        if (mutable.value.busy || !mutable.value.verified || mutable.value.assignments?.open?.none { it.id == id } != false) return
        mutable.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                val assignments = session.completeAssignment(id)
                mutable.update { it.copy(assignments = assignments, message = OperationalMessage("ASSIGNMENT COMPLETED", "This instruction is marked done.", MessageTone.SUCCESS)) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                // No automatic completion retry. Reload assignments before offering another action.
                mutable.update { it.copy(verified = false) }
                fail(failure)
            } finally { mutable.update { it.copy(busy = false) } }
        }
    }

    fun logout() {
        if (mutable.value.busy) return
        explicitSignOut = true
        // Hide worker/task data immediately, not after a potentially slow revocation request.
        mutable.value = WorkerAppState(busy = true)
        viewModelScope.launch {
            try {
                val revoked = session.logout()
                mutable.value = WorkerAppState(message = if (revoked) null else OperationalMessage(
                    "SIGNED OUT ON THIS DEVICE", "Signed out here. Ask your supervisor to check the previous session.", MessageTone.WARNING))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                mutable.value = WorkerAppState(storageLocked = true, message = OperationalMessage(
                    "SECURE SIGN-OUT NOT CONFIRMED", "Stop using this device and ask your supervisor for help."))
            }
        }
    }

    fun expireSession() {
        if (!session.expire(mutable.value.identityVersion)) { refresh(); return }
        mutable.value = WorkerAppState(message = OperationalMessage("SIGN IN REQUIRED", "Your session has ended. Sign in again. Ask your supervisor about any unconfirmed receipt."))
    }

    private fun fail(failure: Exception) {
        if (failure is WorkerRepository.ApiException && failure.code == 401) {
            if (session.expire(mutable.value.identityVersion)) mutable.value = WorkerAppState(message = failure.toOperationalMessage())
            else mutable.update { it.copy(verified = false, message = failure.toOperationalMessage()) }
        } else mutable.update { it.copy(signedIn = session.hasSession, verified = false, message = failure.toOperationalMessage()) }
    }
}
