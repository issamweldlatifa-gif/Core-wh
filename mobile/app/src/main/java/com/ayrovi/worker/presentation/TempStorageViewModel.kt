package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.TemporaryStorageGateway
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.TsStorageWorkflow
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.launch

/**
 * TEMPORARY STORAGE station view model (native worker app / CT40).
 * Pure UI-state bridge: all flow decisions live in TsStorageWorkflow,
 * all persistence/validation lives on the backend — this class only wires
 * screen lifecycles, audio and the hardware scanner gate.
 */
class TempStorageViewModel(
    gateway: TemporaryStorageGateway,
    permissions: Set<String>,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    val workflow = TsStorageWorkflow(gateway, viewModelScope)
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
                        MessageTone.INFO -> Unit
                    }
                }
            }
        }
        viewModelScope.launch { state.collect { updateScannerGate() } }
    }

    /** Scanning is armed only while this screen is visible and work is possible. */
    val captureAllowed: Boolean
        get() = foreground && state.value.canScan

    fun activate(permissions: Set<String>, available: Boolean, connection: ConnectionState = ConnectionState.ONLINE) {
        if (!initialized) {
            initialized = true
            workflow.activate(permissions, available)
        } else {
            workflow.updateAccess(permissions, available)
        }
    }

    fun setForeground(value: Boolean) {
        foreground = value
        updateScannerGate()
        if (value && initialized) workflow.refresh()
    }

    private fun updateScannerGate() {
        scanner.setEnabled(captureAllowed)
        if (captureAllowed) scanner.rearm()
    }

    fun onScan(result: ScanResult) {
        if (captureAllowed) workflow.scan(result.value)
    }
}
