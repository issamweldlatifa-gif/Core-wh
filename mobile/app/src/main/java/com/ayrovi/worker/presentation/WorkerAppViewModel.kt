package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.WorkerAccess
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
    val busy: Boolean = false,
    val verified: Boolean = false,
    val me: MeResponse? = null,
    val context: TerminalContext? = null,
    val tasks: List<TerminalTask> = emptyList(),
    val assignments: AssignmentsResponse? = null,
    val receivingArrivals: Int? = null,
    val message: OperationalMessage? = null,
)

class WorkerAppViewModel(private val repository: WorkerRepository, private val store: SessionStorage) : ViewModel() {
    private val mutable = MutableStateFlow(WorkerAppState(signedIn = store.hasSession()))
    val state = mutable.asStateFlow()
    val connection = repository.connection
    val deviceCode = store.deviceCode
    private var generation = 0L
    private var foreground = false
    private var monitor: Job? = null

    init {
        viewModelScope.launch {
            connection.collect { status ->
                if (status == ConnectionState.AUTH_ERROR && !store.hasSession()) expireSession()
                if (status == ConnectionState.OFFLINE) mutable.update { it.copy(verified = false) }
                if (status == ConnectionState.CHECKING && foreground && store.hasSession()) refresh()
            }
        }
    }

    fun onForeground() {
        foreground = true
        monitor?.cancel()
        monitor = viewModelScope.launch {
            while (isActive) { if (store.hasSession()) refresh(); delay(30_000) }
        }
    }

    fun onBackground() {
        foreground = false
        monitor?.cancel()
        mutable.update { it.copy(verified = false) }
    }

    fun login(identifier: String, secret: String, pin: Boolean) {
        if (mutable.value.busy) return
        if (identifier.isBlank() || secret.isBlank()) {
            mutable.update { it.copy(message = OperationalMessage("SIGN-IN DETAILS REQUIRED", "Enter your employee code and password or PIN.")) }
            return
        }
        mutable.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                repository.login(identifier, secret, if (pin) "pin" else "password", deviceCode)
                mutable.update { it.copy(signedIn = true, loginGeneration = ++generation) }
                loadContext()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fail(failure) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }

    fun refresh() {
        if (mutable.value.busy || !store.hasSession()) return
        mutable.update { it.copy(busy = true, verified = false, message = null) }
        viewModelScope.launch {
            try { loadContext() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { fail(failure) }
            finally { mutable.update { it.copy(busy = false) } }
        }
    }

    private suspend fun loadContext() {
        val me = repository.me()
        if (!WorkerAccess.isWorkerSession(me)) {
            store.clear()
            throw WorkerRepository.ApiException(401, "This session is not authorized for the Worker application.")
        }
        val context = repository.terminalContext()
        if (context.worker?.id != me.user?.id) {
            store.clear()
            throw WorkerRepository.ApiException(401, "Worker identity could not be verified.")
        }
        // Publish fresh authorization even if the optional queue read later fails.
        mutable.update { it.copy(me = me, context = context, tasks = WorkerAccess.visibleTasks(me, context), signedIn = true) }
        val assignments = repository.assignments()
        val count = if (WorkerAccess.VIEW_RECEIVING in me.permissions && WorkerAccess.EXECUTE_RECEIVING in me.permissions)
            repository.arrivals().size else null
        mutable.update { it.copy(assignments = assignments, receivingArrivals = count, verified = foreground, message = null) }
    }

    fun completeAssignment(id: String) {
        if (mutable.value.busy || !mutable.value.verified || mutable.value.assignments?.open?.none { it.id == id } != false) return
        mutable.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                repository.completeAssignment(id)
                val assignments = repository.assignments()
                mutable.update { it.copy(assignments = assignments, message = OperationalMessage("ASSIGNMENT COMPLETED", "The backend recorded this assignment as done.", MessageTone.SUCCESS)) }
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
        mutable.update { it.copy(busy = true, verified = false) }
        viewModelScope.launch {
            try {
                val revoked = repository.logout()
                mutable.value = WorkerAppState(message = if (revoked) null else OperationalMessage(
                    "SIGNED OUT ON THIS DEVICE", "Server logout was not confirmed. Ask an administrator to revoke the previous session.", MessageTone.WARNING))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                mutable.value = WorkerAppState(message = failure.toOperationalMessage())
            }
        }
    }

    fun expireSession() {
        if (store.hasSession()) store.clear()
        mutable.value = WorkerAppState(message = OperationalMessage("SIGN IN REQUIRED", "Your session expired or was revoked. Unconfirmed work will not be replayed."))
    }

    private fun fail(failure: Exception) {
        if (failure is WorkerRepository.ApiException && failure.code == 401) {
            if (store.hasSession()) store.clear()
            mutable.value = WorkerAppState(message = failure.toOperationalMessage())
        } else mutable.update { it.copy(signedIn = store.hasSession(), verified = false, message = failure.toOperationalMessage()) }
    }
}
