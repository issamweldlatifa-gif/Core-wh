package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.ReceivingHomeWorkflow
import com.ayrovi.worker.feedback.ReceivingNotifier
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.launch

/**
 * RECEIVING HOME — the new worker entry. The two intents are the two real
 * workflow entries: PRODUIT and CARTON. There is no arrival picker, no
 * manual "send": the card feed is dispatched automatically by the backend.
 */
sealed interface ReceivingHomeIntent {
    data object OpenProduct : ReceivingHomeIntent
    data object OpenCarton : ReceivingHomeIntent
    data object BackHome : ReceivingHomeIntent
    data object Confirm : ReceivingHomeIntent
    data object Refresh : ReceivingHomeIntent
}

class ReceivingHomeViewModel(
    gateway: ReceivingGateway,
    workerId: String,
    permissions: Set<String>,
    private val audio: AudioFeedback = AudioFeedback.Silent,
    private val notifier: ReceivingNotifier? = null,
) : ViewModel() {
    val workflow = ReceivingHomeWorkflow(gateway, workerId, permissions, viewModelScope)
    val state = workflow.state
    val scanner = ScannerManager()

    private var initialized = false
    private var foreground = false

    init {
        viewModelScope.launch {
            workflow.events.collect { event ->
                runCatching {
                    when (event.tone) {
                        MessageTone.SUCCESS -> if (foreground) audio.success()
                        MessageTone.ERROR -> if (foreground) audio.error()
                        MessageTone.WARNING -> if (foreground) audio.warning()
                        MessageTone.INFO -> {
                            // A newly dispatched card: in-app sound + a device
                            // tray notification (works on phone and CT40), so a
                            // worker discovers a card WITHOUT opening Receiving.
                            audio.notification()
                            when (event.title) {
                                "NEW PRODUCT CARD" -> notifier?.newCard(product = true, count = state.value.home?.productCardsPending ?: 1)
                                "NEW CARTON CARD" -> notifier?.newCard(product = false, count = state.value.home?.cartonCardsPending ?: 1)
                            }
                        }
                    }
                }
            }
        }
        viewModelScope.launch { state.collect { updateScannerGate() } }
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
    }

    fun setForeground(value: Boolean) {
        foreground = value
        updateScannerGate()
        if (value) {
            workflow.startAutoRefresh()
            if (initialized && !state.value.busy) workflow.refresh()
        } else {
            workflow.stopAutoRefresh()
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
            ReceivingHomeIntent.BackHome -> { scanner.rearm(); workflow.backToHome() }
            ReceivingHomeIntent.Confirm -> workflow.confirm()
            ReceivingHomeIntent.Refresh -> workflow.refresh()
        }
    }
}
