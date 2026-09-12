package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.BatchReceiveWorkflow
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.ScannerManager
import com.ayrovi.worker.scanner.ScanResult
import kotlinx.coroutines.launch

/**
 * BATCH receiving gateway adapter — same ONE WorkerRepository transport
 * (mirror of RepoBatchGateway on the build side).
 */
class RepoBatchReceiveGateway(private val repo: com.ayrovi.worker.data.WorkerRepository) : BatchGateway by repo

/**
 * BATCH RECEIVE view-model — TempStorage-shaped wrapper: scanner gate (ONE
 * surface), audio, foreground lifecycle; ALL rules live in
 * BatchReceiveWorkflow (worker-core, JVM-tested).
 */
class BatchReceiveViewModel(
    gateway: BatchGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {

    val workflow = BatchReceiveWorkflow(gateway, viewModelScope)
    val state = workflow.state
    val scanner = ScannerManager()

    private var foreground = false

    init {
        viewModelScope.launch {
            workflow.events.collect { event ->
                runCatching {
                    when (event.tone) {
                        MessageTone.SUCCESS -> if (foreground) audio.success()
                        MessageTone.ERROR -> if (foreground) audio.error()
                        MessageTone.WARNING -> if (foreground) audio.warning()
                        MessageTone.INFO -> Unit
                    }
                }
            }
        }
        viewModelScope.launch { state.collect { updateScannerGate() } }
    }

    val captureAllowed: Boolean
        get() = foreground && state.value.canScan

    fun activate(available: Boolean) {
        workflow.activate(authorized = true, serverAvailable = available)
    }

    fun setForeground(value: Boolean) {
        foreground = value
        updateScannerGate()
        if (value) workflow.refresh()
    }

    private fun updateScannerGate() {
        scanner.setEnabled(captureAllowed)
        if (captureAllowed) scanner.rearm()
    }

    fun onScan(result: ScanResult) {
        if (captureAllowed) workflow.onScan(result.value)
    }
}
