package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.MutationJournal
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.ReceivingFeedbackController
import com.ayrovi.worker.domain.ReceivingMode
import com.ayrovi.worker.domain.ReceivingWorkflow
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.launch

/** Both device presentations dispatch these same intents; neither calls an API or owns business state. */
sealed interface ReceivingIntent {
    data class SelectMode(val mode: ReceivingMode) : ReceivingIntent
    data class OpenArrival(val code: String) : ReceivingIntent
    data class Quantity(val value: String) : ReceivingIntent
    data class ReportProblem(val reason: String) : ReceivingIntent
    data class ResolveProblem(val id: String, val reason: String) : ReceivingIntent
    data object ConfirmCarton : ReceivingIntent
    data object ConfirmProduct : ReceivingIntent
    data object NextProduct : ReceivingIntent
    data object ChangeSource : ReceivingIntent
    data object ChangeTote : ReceivingIntent
    data object Pause : ReceivingIntent
    data object Resume : ReceivingIntent
    data object ReviewCompletion : ReceivingIntent
    data object Complete : ReceivingIntent
    data object NextArrival : ReceivingIntent
    data object Refresh : ReceivingIntent
}

class ReceivingViewModel(
    gateway: ReceivingGateway, journal: MutationJournal, workerId: String, permissions: Set<String>,
    audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    val workflow = ReceivingWorkflow(gateway, journal, workerId, permissions, viewModelScope)
    val state = workflow.state
    val scanner = ScannerManager()
    private val feedback = ReceivingFeedbackController(workflow, scanner, audio, viewModelScope)
    val ui = feedback.state
    private var initialized = false
    private var foreground = false
    private var overlay = false
    val captureAllowed: Boolean get() = foreground && !overlay && state.value.canScan &&
        !(state.value.session == null && state.value.loaded && state.value.arrivals.isEmpty())

    init { viewModelScope.launch { state.collect { updateScannerGate() } } }

    fun activate(permissions: Set<String>, available: Boolean, recoverySessionId: String?, connection: ConnectionState = ConnectionState.ONLINE) {
        feedback.setConnection(connection)
        workflow.updateAccess(permissions, available)
        if (available && (!initialized || !state.value.loaded) && !state.value.busy) {
            initialized = true
            workflow.initialize(recoverySessionId)
        }
    }
    fun setForeground(value: Boolean) { foreground = value; feedback.setForeground(value); updateScannerGate() }
    fun setOverlay(value: Boolean) { overlay = value; updateScannerGate() }
    private fun updateScannerGate() { scanner.setEnabled(captureAllowed) }
    fun onScan(result: ScanResult) { if (captureAllowed) workflow.scan(result) }

    fun send(intent: ReceivingIntent) {
        // Only explicit operator re-arm, never an automatic backend step transition.
        if (!state.value.busy && intent in setOf(ReceivingIntent.NextProduct, ReceivingIntent.NextArrival)) scanner.rearm()
        when (intent) {
            is ReceivingIntent.SelectMode -> { if (state.value.canSelectMode) scanner.rearm(); workflow.selectMode(intent.mode) }
            is ReceivingIntent.OpenArrival -> workflow.openArrival(intent.code)
            is ReceivingIntent.Quantity -> workflow.setQuantity(intent.value)
            is ReceivingIntent.ReportProblem -> workflow.reportException(intent.reason)
            is ReceivingIntent.ResolveProblem -> workflow.resolveException(intent.id, intent.reason)
            ReceivingIntent.ConfirmCarton -> workflow.confirmCarton()
            ReceivingIntent.ConfirmProduct -> workflow.confirmProduct()
            ReceivingIntent.NextProduct -> workflow.nextProduct()
            ReceivingIntent.ChangeSource -> workflow.changeCarton()
            ReceivingIntent.ChangeTote -> workflow.changeTote()
            ReceivingIntent.Pause -> workflow.pause()
            ReceivingIntent.Resume -> workflow.resume()
            ReceivingIntent.ReviewCompletion -> workflow.reviewCompletion()
            ReceivingIntent.Complete -> workflow.complete()
            ReceivingIntent.NextArrival -> workflow.nextArrival()
            ReceivingIntent.Refresh -> workflow.refresh()
        }
    }
}
