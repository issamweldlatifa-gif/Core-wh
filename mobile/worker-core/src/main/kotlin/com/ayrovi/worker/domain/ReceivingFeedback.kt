package com.ayrovi.worker.domain

import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.scanner.ScannerManager
import com.ayrovi.worker.scanner.ScannerNotice
import com.ayrovi.worker.scanner.ScannerStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** UI phases only: these are NOT new warehouse/backend states. */
enum class TerminalPhase { READY, SCANNING, VALIDATING, SUCCESS, ERROR, WARNING, WAITING, OFFLINE, EMPTY }

data class TerminalFeedback(
    val phase: TerminalPhase, val title: String, val detail: String = "", val code: String? = null,
    val transient: Boolean = false,
)

data class ReceivingPresentation(
    val workflow: ReceivingState,
    val feedback: TerminalFeedback,
    val step: Int?,
    val instruction: String,
    val target: String,
) {
    val captureVisible: Boolean get() = workflow.step in setOf(ReceivingStep.ARRIVAL, ReceivingStep.CARTON, ReceivingStep.TOTE, ReceivingStep.PRODUCT)
    val emptyQueue: Boolean get() = workflow.loaded && workflow.session == null && workflow.arrivals.isEmpty() && workflow.step == ReceivingStep.ARRIVAL
}

/** One feedback/auto-return policy shared by Phone and CT40. No stock dispatch/replay here. */
class ReceivingFeedbackController(
    private val workflow: ReceivingWorkflow,
    private val scanner: ScannerManager,
    private val audio: AudioFeedback,
    private val scope: CoroutineScope,
    private val feedbackMillis: Long = 1_100,
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val flash = MutableStateFlow<TerminalFeedback?>(null)
    private val connection = MutableStateFlow(ConnectionState.CHECKING)
    private var foreground = false
    private var timer: Job? = null
    private var lastRejection: String? = null
    private var lastRejectionAt = Long.MIN_VALUE
    private val mutable = MutableStateFlow(project(workflow.state.value, scanner.state.value.status, connection.value, null))
    val state: StateFlow<ReceivingPresentation> = mutable.asStateFlow()

    init {
        scope.launch {
            combine(workflow.state, scanner.state, connection, flash) { work, scan, link, notice -> project(work, scan.status, link, notice) }
                .collect { mutable.value = it }
        }
        scope.launch { workflow.events.collect { event ->
            if (foreground) show(TerminalFeedback(when (event.tone) {
                MessageTone.SUCCESS -> TerminalPhase.SUCCESS
                MessageTone.ERROR -> TerminalPhase.ERROR
                MessageTone.WARNING -> TerminalPhase.WARNING
                MessageTone.INFO -> TerminalPhase.WAITING
            }, event.title, event.detail, event.code, transient = true))
        } }
        scope.launch { scanner.events.collect { if (foreground) scannerNotice(it) } }
    }
    fun setConnection(value: ConnectionState) { connection.value = value }
    fun setForeground(value: Boolean) {
        foreground = value
        if (!value) { timer?.cancel(); flash.value = null }
    }
    private fun scannerNotice(event: ScannerNotice) {
        val key = "${event.status}:${event.code}"
        val now = clock()
        val held = lastRejection == key && now - lastRejectionAt < feedbackMillis
        lastRejection = key; lastRejectionAt = now
        if (held) return // no continuous beeping/pulse from a held bad label
        val status = when (event.status) {
            ScannerStatus.INVALID, ScannerStatus.DUPLICATE, ScannerStatus.TIMEOUT -> TerminalPhase.ERROR
            ScannerStatus.UNAVAILABLE -> TerminalPhase.WARNING
            else -> return
        }
        show(TerminalFeedback(status, when (event.status) {
            ScannerStatus.DUPLICATE -> "ALREADY SCANNED"
            ScannerStatus.TIMEOUT -> "NO CODE READ"
            ScannerStatus.UNAVAILABLE -> "SCANNER UNAVAILABLE"
            else -> "INVALID CODE"
        }, WorkerMessages.reason(event.detail, "Scan again or use manual entry."), event.code, transient = true))
    }
    private fun show(value: TerminalFeedback) {
        timer?.cancel()
        flash.value = value
        // Audio failure is independent of rendering and workflow progress.
        runCatching { when (value.phase) {
            TerminalPhase.SUCCESS -> audio.success()
            TerminalPhase.ERROR -> audio.error()
            TerminalPhase.WARNING -> audio.warning()
            else -> Unit
        } }
        timer = scope.launch { delay(feedbackMillis); flash.value = null }
    }

    companion object {
        fun project(work: ReceivingState, scanner: ScannerStatus, connection: ConnectionState, flash: TerminalFeedback?): ReceivingPresentation {
            val step = when (work.step) {
                ReceivingStep.ARRIVAL -> 1
                ReceivingStep.CARTON, ReceivingStep.CONFIRM_CARTON -> 2
                ReceivingStep.TOTE, ReceivingStep.PRODUCT -> 3
                ReceivingStep.REVIEW_PRODUCT -> 4
                ReceivingStep.REVIEW_COMPLETE, ReceivingStep.RESULT -> 6
                ReceivingStep.COMPLETE -> 7
                ReceivingStep.PAUSED, ReceivingStep.RECONCILE -> null
            }
            val instruction = when (work.step) {
                ReceivingStep.ARRIVAL -> "SCAN ARRIVAL"
                ReceivingStep.CARTON -> if (work.mode == ReceivingMode.CARTONS) "SCAN CARTON" else "SCAN SOURCE CARTON"
                ReceivingStep.CONFIRM_CARTON -> "CONFIRM CARTON"
                ReceivingStep.TOTE -> "SCAN RECEIVING TOTE"
                ReceivingStep.PRODUCT -> "SCAN PRODUCT"
                ReceivingStep.REVIEW_PRODUCT -> "CHECK QUANTITY"
                ReceivingStep.RESULT -> "UNIT RECORDED"
                ReceivingStep.REVIEW_COMPLETE -> "REVIEW RECEIVING"
                ReceivingStep.COMPLETE -> if (work.session?.status == "CANCELLED") "TASK CANCELLED" else "RECEIVING COMPLETE"
                ReceivingStep.PAUSED -> "RECEIVING PAUSED"
                ReceivingStep.RECONCILE -> "SUPERVISOR REQUIRED"
            }
            val target = when (work.step) {
                ReceivingStep.ARRIVAL -> "ARRIVAL"
                ReceivingStep.CARTON, ReceivingStep.CONFIRM_CARTON -> "CARTON"
                ReceivingStep.TOTE -> "TOTE"
                else -> "PRODUCT"
            }
            val view = when {
                work.authExpired || connection == ConnectionState.AUTH_ERROR -> TerminalFeedback(TerminalPhase.ERROR, "SIGN IN REQUIRED", "Your session has ended.")
                !work.busy && (work.storageBlocked || (work.pending != null && work.pending.confirmedReceipt == null)) -> TerminalFeedback(TerminalPhase.WARNING,
                    "SUPERVISOR REQUIRED", "Do not receive this item again. Ask your supervisor to check the receipt.")
                !work.authorized -> TerminalFeedback(TerminalPhase.ERROR,
                    work.message?.title ?: "ACCESS REQUIRED",
                    WorkerMessages.reason(work.message?.detail, "Ask your supervisor to check your assignment."), work.message?.scanned)
                connection in setOf(ConnectionState.OFFLINE, ConnectionState.SYNC_ERROR) -> TerminalFeedback(TerminalPhase.OFFLINE,
                    "CONNECTION UNAVAILABLE", "Receiving is stopped. Reconnect to continue.")
                !work.serverAvailable -> TerminalFeedback(TerminalPhase.WAITING, "CHECKING CONNECTION", "Please wait.")
                work.busy -> TerminalFeedback(TerminalPhase.VALIDATING, "VALIDATING", "Checking ${target.lowercase()}…", work.lastScanValue)
                flash != null -> flash
                !work.loaded -> TerminalFeedback(TerminalPhase.WAITING, "OPENING RECEIVING", work.message?.detail ?: "Please wait.")
                work.step == ReceivingStep.ARRIVAL && work.session == null && work.arrivals.isEmpty() -> TerminalFeedback(TerminalPhase.EMPTY,
                    "NO ARRIVALS WAITING", "No receiving work is currently waiting.")
                work.step == ReceivingStep.PAUSED -> TerminalFeedback(TerminalPhase.WAITING, "PAUSED", "Resume when ready.")
                work.step == ReceivingStep.RESULT -> TerminalFeedback(if (work.receipt?.withException == true) TerminalPhase.WARNING else TerminalPhase.SUCCESS,
                    if (work.restoredReceipt) "PREVIOUS UNIT RECORDED" else "UNIT RECORDED", "Check placement, then acknowledge.", work.receipt?.articleCode)
                work.step == ReceivingStep.COMPLETE -> TerminalFeedback(if (work.session?.status == "COMPLETED") TerminalPhase.SUCCESS else TerminalPhase.WARNING,
                    instruction, "Return to the work queue.", work.session?.arrival?.code)
                scanner == ScannerStatus.UNAVAILABLE -> TerminalFeedback(TerminalPhase.WARNING, "SCANNER UNAVAILABLE", "Use manual entry or ask your supervisor.")
                scanner == ScannerStatus.SCANNING && work.canScan -> TerminalFeedback(TerminalPhase.SCANNING, "SCANNING", "Keep the label in view.")
                work.canScan -> TerminalFeedback(TerminalPhase.READY, "READY TO SCAN", "Read the ${target.lowercase()} label.")
                work.message?.tone == MessageTone.ERROR -> TerminalFeedback(TerminalPhase.ERROR, work.message.title, work.message.detail, work.message.scanned)
                else -> TerminalFeedback(TerminalPhase.WAITING, instruction, "Check the details below.")
            }
            return ReceivingPresentation(work, view, step, instruction, target)
        }
    }
}
