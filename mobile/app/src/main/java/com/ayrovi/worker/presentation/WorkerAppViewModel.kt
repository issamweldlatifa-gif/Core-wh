package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.PushRegistration
import com.ayrovi.worker.domain.WorkerSessionUseCase
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.WorkerQueuePolicy
import com.ayrovi.worker.domain.CardNotificationCenter
import com.ayrovi.worker.domain.CardNotificationState
import com.ayrovi.worker.domain.CardReadStore
import com.ayrovi.worker.domain.InMemoryCardReadStore
import com.ayrovi.worker.domain.toOperationalMessage
import com.ayrovi.worker.feedback.ReceivingNotifier
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
    val workCounts: List<WorkCount> = emptyList(),
    val message: OperationalMessage? = null,
    /** Live per-lane pending counters from the whole-app poll (see loadContext). */
    val receivingProductPending: Int? = null,
    val receivingCartonPending: Int? = null,
    /** Last authoritative card feed — the input to the unread badge model. */
    val receivingHome: ReceivingHome? = null,
    /** UNREAD notification state (badge source of truth on the device). */
    val notifications: CardNotificationState = CardNotificationState(),
) {
    val queueItems get() = WorkerQueuePolicy.items(tasks, receivingArrivals, workCounts, notifications.unreadTotal)
    /** Whole-app unread badge (null instead of a drawn zero). */
    val unreadBadge: Int? get() = notifications.badge
}

class WorkerAppViewModel(
    private val session: WorkerSessionUseCase,
    private val audio: AudioFeedback = AudioFeedback.Silent,
    private val notifier: ReceivingNotifier? = null,
    private val readStore: CardReadStore = InMemoryCardReadStore(),
    /** Uploads the FCM token once a session exists (null in tests/previews). */
    private val pushRegistration: PushRegistration? = null,
) : ViewModel() {
    private val mutable = MutableStateFlow(WorkerAppState(signedIn = session.hasSession))
    val state = mutable.asStateFlow()
    val connection = session.connection
    val deviceCode = session.deviceCode
    private var generation = 0L
    private var explicitSignOut = false
    private var foreground = false
    private var monitor: Job? = null
    /** Read-set rehydrated once per signed-in session (see loadContext). */
    private var restored = false

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
                restored = false // rehydrate this worker's read set on the next context load
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
        val previousProduct = mutable.value.receivingProductPending
        val previousCarton = mutable.value.receivingCartonPending
        val verified = session.loadContext()
        // The session is authenticated here, so this is the first point at
        // which the parked FCM token can be uploaded. It is a no-op unless the
        // token is new, and it never throws — push must not break receiving.
        runCatching { pushRegistration?.syncAfterLogin() }
        val incoming = verified.receivingArrivalCount
        if (foreground) {
            val newProduct = verified.receivingProductPending
            val newCarton = verified.receivingCartonPending
            val productArrived = previousProduct != null && newProduct != null && newProduct > previousProduct
            val cartonArrived = previousCarton != null && newCarton != null && newCarton > previousCarton
            if (productArrived || cartonArrived) {
                // A newly dispatched card: ONE tray notification + sound, from
                // any screen (Receiving Home, the work queue, wherever). This is
                // the single notifier owner — ReceivingHomeViewModel only plays
                // scan sounds, so a card is never announced twice.
                runCatching { audio.notification() }
                if (productArrived) notifier?.newCard(product = true, count = newProduct)
                if (cartonArrived) notifier?.newCard(product = false, count = newCarton)
            } else if (previous != null && incoming != null && incoming > previous) {
                runCatching { audio.notification() }
            }
            // A completed lane (pending back to zero / fewer than before) must
            // not leave a stale "card waiting" tray notification on Home. Clear
            // the lane notification as soon as its queue drains — this is the
            // notification half of the backend state update; the in-app counters
            // below already reflect the fresh feed.
            if (newProduct != null && newProduct == 0) notifier?.clearCard(product = true)
            if (newCarton != null && newCarton == 0) notifier?.clearCard(product = false)
        }
        // After a fresh sign-in / process restart the in-memory read set is
        // empty: rehydrate it from the store first, so already-read cards are
        // never re-announced as unread (TEST 10 / TEST 11).
        if (!restored) { restoreReads(verified.me?.user?.id); restored = true }
        // Recompute UNREAD against the fresh feed. Cards that left the feed
        // (completed, or force-deleted by an admin) are pruned here, so the
        // badge reaches 0 immediately — no restart, re-login or manual refresh.
        val reconciled = CardNotificationCenter.reconcile(mutable.value.notifications, verified.receivingHome)
        persistReads(verified.me?.user?.id, reconciled)
        // A lane whose unread count fell to zero must not keep a tray
        // notification claiming a card is waiting.
        if (reconciled.unreadProduct == 0) notifier?.clearCard(product = true)
        if (reconciled.unreadCarton == 0) notifier?.clearCard(product = false)
        mutable.update { it.copy(
            signedIn = true, me = verified.me, context = verified.context, tasks = verified.tasks,
            assignments = verified.assignments, receivingArrivals = verified.receivingArrivalCount, workCounts = verified.workCounts,
            identityVersion = verified.identityVersion, verified = foreground, message = null,
            receivingProductPending = verified.receivingProductPending,
            receivingCartonPending = verified.receivingCartonPending,
            receivingHome = verified.receivingHome,
            notifications = reconciled,
        ) }
    }

    /** Persist the read set so it survives process death and re-login (TEST 10/11). */
    private fun persistReads(workerId: String?, state: CardNotificationState) {
        val id = workerId ?: return
        runCatching { readStore.save(id, state.readProduct, state.readCarton) }
    }

    /** Restore the read set for the signed-in worker before the first reconcile. */
    private fun restoreReads(workerId: String?) {
        val id = workerId ?: return
        val (product, carton) = runCatching { readStore.load(id) }.getOrDefault(emptySet<String>() to emptySet())
        mutable.update { it.copy(notifications = it.notifications.copy(readProduct = product, readCarton = carton)) }
    }

    /**
     * The worker opened a receiving lane: every card visible in it becomes
     * READ and the badge drops immediately, without waiting for the next poll.
     */
    /**
     * v1.7.5: wipe ALL operational traces stored on the device (per-worker
     * receiving read-sets). Settings action next to the automatic wipe that
     * runs when a rapport is submitted. Never touches sign-in / push /
     * appearance data.
     */
    fun purgeOperationalData() { runCatching { readStore.clearAll() } }

    fun markReceivingRead(product: Boolean? = null) {
        val current = mutable.value
        val home = current.receivingHome
        val updated = when (product) {
            true -> CardNotificationCenter.markProductRead(current.notifications, home)
            false -> CardNotificationCenter.markCartonRead(current.notifications, home)
            null -> CardNotificationCenter.markAllRead(current.notifications, home)
        }
        persistReads(current.me?.user?.id, updated)
        if (updated.unreadProduct == 0) notifier?.clearCard(product = true)
        if (updated.unreadCarton == 0) notifier?.clearCard(product = false)
        mutable.update { it.copy(notifications = updated) }
    }

    fun completeAssignment(id: String) {
        if (mutable.value.busy || !mutable.value.verified || mutable.value.assignments?.open?.none { it.id == id && it.isInstruction && it.status in setOf("ASSIGNED", "IN_PROGRESS") } != false) return
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

    /**
     * A queue tile for a task that is not piloted on this handset yet
     * (Sorting, Putaway, …). The tile stays pressable and answers with an
     * explicit notice instead of silently opening Receiving — every lane keeps
     * its own action.
     */
    fun noticeTask(label: String) {
        mutable.update { it.copy(message = OperationalMessage(label.uppercase(), "This task is not piloted on this handset yet. Receiving stays available.", MessageTone.INFO)) }
    }

    fun logout() {
        if (mutable.value.busy) return
        explicitSignOut = true
        restored = false
        // Remove any waiting-card tray notifications with the session. The
        // persisted READ set is deliberately kept: signing back in must not
        // resurrect notifications the worker already read (TEST 11).
        notifier?.clearAll()
        // Hide worker/task data immediately, not after a potentially slow revocation request.
        mutable.value = WorkerAppState(busy = true)
        viewModelScope.launch {
            try {
                // Release the push token first: a signed-out handset must stop
                // receiving cards even if revocation later fails.
                runCatching { pushRegistration?.releaseOnLogout() }
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
