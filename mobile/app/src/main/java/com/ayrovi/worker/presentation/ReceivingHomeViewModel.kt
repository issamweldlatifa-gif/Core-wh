package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.ReceivingHomeWorkflow
import com.ayrovi.worker.scanner.ScanDecision
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * RECEIVING HOME — the new worker entry. The intents are the real workflow
 * entries: PRODUIT, CARTON and the AUTO scan tool (HOME "QR CODE"). There is
 * no arrival picker, no manual "send": the card feed is dispatched
 * automatically by the backend.
 */
sealed interface ReceivingHomeIntent {
    data object OpenProduct : ReceivingHomeIntent
    data object OpenCarton : ReceivingHomeIntent
    /** UX RESTRUCTURE §9: HOME "QR CODE" tool — scanner opens directly, product OR carton. */
    data object OpenAutoScan : ReceivingHomeIntent
    data object BackHome : ReceivingHomeIntent
    data object Confirm : ReceivingHomeIntent
    data object Refresh : ReceivingHomeIntent
    data object Retry : ReceivingHomeIntent
}

/**
 * RECEIVING WORK CENTER summary (UX RESTRUCTURE §6/§12) — built ONLY from the
 * existing open-session data the report already uses. It feeds the DONE and
 * ISSUES groups; null (no open session / older backend) simply hides them.
 * No new business rules: the backend tally/discrepancies keep their meaning.
 */
data class ReceivingWorkSummary(
    val sessionCode: String?,
    val status: String?,
    val unitsReceived: Int,
    val unitsExpected: Int,
    val cartonsReceived: Int,
    val cartonsExpected: Int,
    val openDiscrepancies: Int,
)

/**
 * One persistent ISSUE row for the ISSUES group (§12): the device-side error
 * state (e.g. NOT MATCHED — "The failure was logged."), kept after the scan
 * verdict overlay so the worker sees the open issue inside Receiving until a
 * successful scan resolves the work. Memory only — the backend log stays the
 * record; nothing here changes the error flow itself.
 */
data class ReceivingIssueState(val title: String, val detail: String, val code: String?)

class ReceivingHomeViewModel(
    private val gateway: ReceivingGateway,
    workerId: String,
    permissions: Set<String>,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    val workflow = ReceivingHomeWorkflow(gateway, workerId, permissions, viewModelScope)
    val state = workflow.state
    // v1.7.5 CONTINUOUS SESSION: the camera stays open between reads, so
    // the duplicate echo window grows 1.5s -> 6s: a label still in front of
    // the lens is swallowed SILENTLY (no verdict, no count, no flash) while
    // the backend/device guards behind it still reject true re-counts.
    val scanner = ScannerManager(ScanDecision(windowMs = 6_000, debounceMs = 0))

    private val mutableSummary = MutableStateFlow<ReceivingWorkSummary?>(null)

    /** Existing open-session tally (DONE group source of truth on device). */
    val workSummary = mutableSummary.asStateFlow()

    private val mutableIssue = MutableStateFlow<ReceivingIssueState?>(null)

    /** Last device-side ERROR state (ISSUES group, §12) until a scan succeeds. */
    val issue = mutableIssue.asStateFlow()

    private var initialized = false
    private var foreground = false
    private var summaryLoading = false

    init {
        viewModelScope.launch {
            workflow.events.collect { event ->
                runCatching {
                    when (event.tone) {
                        // SUCCESS/ERROR/WARNING play only while THIS screen is
                        // foregrounded. Newly dispatched cards are announced by
                        // the whole-app WorkerAppViewModel (audio + tray on any
                        // screen); Receiving itself only updates its live feed.
                        MessageTone.SUCCESS -> {
                            if (foreground) audio.success()
                            // A successful scan resolves the open issue state
                            // and changes the session tally: refresh both.
                            mutableIssue.value = null
                            refreshSummary()
                        }
                        MessageTone.ERROR -> {
                            if (foreground) audio.error()
                            mutableIssue.value = ReceivingIssueState(event.title, event.detail, event.code)
                        }
                        MessageTone.WARNING -> if (foreground) audio.warning()
                        MessageTone.INFO -> Unit
                    }
                }
            }
        }
        // STABILITY FIX: the scanner gate reacts to CHANGES only. Re-arming
        // the capture host on every state emission (busy toggling during
        // every refresh) churned the capture pipeline — shake/flicker fuel.
        viewModelScope.launch {
            var lastGate = false
            state.collect {
                val gate = captureAllowed
                if (gate != lastGate) {
                    scanner.setEnabled(gate)
                    if (gate) scanner.rearm()
                    lastGate = gate
                }
            }
        }
        refreshSummary()
    }

    /** Scanning is only ever armed inside a dedicated lane scanner screen. */
    val captureAllowed: Boolean
        get() = foreground && state.value.canScan

    fun activate(permissions: Set<String>, available: Boolean, connection: ConnectionState = ConnectionState.ONLINE) {
        workflow.updateAccess(permissions, available)
        if (available && !initialized && !state.value.busy) {
            initialized = true
            workflow.initialize()
        }
        // Summary refresh deliberately NOT here: activate() fires on every
        // connection/permission emission, and each summary update recomposes
        // the overview. It runs on foreground entry and after a scan instead.
    }

    fun setForeground(value: Boolean) {
        foreground = value
        updateScannerGate()
        if (value) {
            workflow.startAutoRefresh()
            if (initialized && !state.value.busy) workflow.refresh()
            refreshSummary()
        } else {
            workflow.stopAutoRefresh()
        }
    }

    /**
     * Pull the EXISTING reportable session (same call the confirmation report
     * uses) for the DONE/ISSUES groups. Never throws into the workflow: any
     * failure just leaves the previous summary (or hides the groups).
     */
    private fun refreshSummary() {
        if (summaryLoading) return
        summaryLoading = true
        viewModelScope.launch {
            try {
                val session = runCatching { gateway.activeReceivingSession() }.getOrNull()
                mutableSummary.value = session?.let { s ->
                    ReceivingWorkSummary(
                        sessionCode = s.code, status = s.status,
                        unitsReceived = s.tally.receivedUnits, unitsExpected = s.tally.expectedUnits,
                        cartonsReceived = s.tally.receivedCartons, cartonsExpected = s.tally.expectedCartons,
                        openDiscrepancies = s.tally.openDiscrepancies,
                    )
                }
            } finally {
                summaryLoading = false
            }
        }
    }

    private fun updateScannerGate() {
        scanner.setEnabled(captureAllowed)
        if (captureAllowed) scanner.rearm()
    }

    fun onScan(result: ScanResult) { if (captureAllowed) workflow.scan(result) }

    fun send(intent: ReceivingHomeIntent) {
        when (intent) {
            ReceivingHomeIntent.OpenProduct -> { scanner.rearm(); workflow.openProduct() }
            ReceivingHomeIntent.OpenCarton -> { scanner.rearm(); workflow.openCarton() }
            ReceivingHomeIntent.OpenAutoScan -> { scanner.rearm(); workflow.openAutoScan() }
            ReceivingHomeIntent.BackHome -> { scanner.rearm(); workflow.backToHome(); refreshSummary() }
            ReceivingHomeIntent.Confirm -> workflow.confirm()
            ReceivingHomeIntent.Refresh -> workflow.refresh()
            ReceivingHomeIntent.Retry -> { scanner.rearm(); workflow.retry() }
        }
    }
}
