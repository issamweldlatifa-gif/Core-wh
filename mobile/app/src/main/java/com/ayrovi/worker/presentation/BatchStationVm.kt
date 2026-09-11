package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.ScannerManager
import com.ayrovi.worker.scanner.ScanResult
import kotlinx.coroutines.launch

/**
 * BATCH gateway adapter — the /v1/batches worker contract through the ONE
 * WorkerRepository (same shape as RepoPackingGateway/RepoShippingGateway).
 */
class RepoBatchGateway(private val repo: WorkerRepository) : BatchGateway by repo

/**
 * BATCH BUILD view-model — thin TempStorageViewModel-shaped wrapper:
 * owns the scanner gate (ONE surface), audio feedback and the foreground
 * lifecycle; ALL rules live in BatchBuildWorkflow (worker-core, JVM-tested).
 */
class BatchViewModel(
    gateway: BatchGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {

    val workflow = BatchBuildWorkflow(gateway, viewModelScope)
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

    /** Scanning is armed only while this screen is visible and a build is open. */
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
