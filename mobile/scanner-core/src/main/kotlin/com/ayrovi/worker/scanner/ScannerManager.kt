package com.ayrovi.worker.scanner

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ScanSource { CAMERA, EXTERNAL_SCANNER, MANUAL }
enum class ScanSymbology { BARCODE, QR, UNKNOWN }

data class ScanResult(val value: String, val source: ScanSource, val symbology: ScanSymbology = ScanSymbology.UNKNOWN) {
    val scanType: String get() = when {
        source == ScanSource.MANUAL -> "MANUAL"
        symbology == ScanSymbology.QR -> "QR"
        else -> "BARCODE"
    }
}

enum class ScannerStatus { DISABLED, READY, SCANNING, CAPTURED, INVALID, DUPLICATE, CANCELLED, TIMEOUT, UNAVAILABLE }
data class ScannerNotice(val status: ScannerStatus, val detail: String, val code: String? = null)
data class ScannerState(val status: ScannerStatus = ScannerStatus.DISABLED, val detail: String = "Scanner paused", val result: ScanResult? = null)

/** Capture policy only. Backend matching/permission/quantity rules do not belong here. */
class ScannerManager(
    private val decision: ScanDecision = ScanDecision(debounceMs = 0),
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    initiallyEnabled: Boolean = false,
) {
    private val mutable = MutableStateFlow(ScannerState())
    val state = mutable.asStateFlow()
    private val notices = MutableSharedFlow<ScannerNotice>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events = notices.asSharedFlow()
    private var enabled = initiallyEnabled
    init { if (enabled) mutable.value = ScannerState(ScannerStatus.READY, "Ready for a barcode") }

    @Synchronized fun setEnabled(value: Boolean) {
        if (value == enabled) return
        enabled = value
        mutable.value = if (value) ScannerState(ScannerStatus.READY, "Ready for a barcode") else ScannerState()
    }

    @Synchronized fun rearm() {
        decision.reset()
        if (enabled) mutable.value = ScannerState(ScannerStatus.READY, "Ready for the next physical item")
    }

    @Synchronized fun capture(raw: String, source: ScanSource, symbology: ScanSymbology = ScanSymbology.UNKNOWN): ScanResult? {
        if (!enabled) { decision.observeWhileDisabled(raw, clock()); return null }
        return when (val outcome = decision.evaluate(raw, clock())) {
            is ScanOutcome.Accepted -> ScanResult(outcome.value, source, symbology).also {
                mutable.value = ScannerState(ScannerStatus.CAPTURED, "Code read. Checking…", it)
            }
            is ScanOutcome.Rejected -> {
                mutable.value = when (outcome.reason) {
                    RejectReason.DUPLICATE, RejectReason.DEBOUNCED -> ScannerState(ScannerStatus.DUPLICATE, "Already scanned. Read the next label.")
                    RejectReason.EMPTY -> ScannerState(ScannerStatus.INVALID, "No barcode was read")
                    RejectReason.INVALID -> ScannerState(ScannerStatus.INVALID, "Invalid code. Scan again.")
                }
                notices.tryEmit(ScannerNotice(mutable.value.status, mutable.value.detail, raw.take(1024)))
                null
            }
        }
    }

    @Synchronized fun beginScan() { if (enabled) mutable.value = ScannerState(ScannerStatus.SCANNING, "Scanning…") }
    @Synchronized fun timeout() {
        if (enabled && mutable.value.status == ScannerStatus.SCANNING) {
            mutable.value = ScannerState(ScannerStatus.TIMEOUT, "No code read. Scan again.")
            notices.tryEmit(ScannerNotice(ScannerStatus.TIMEOUT, mutable.value.detail))
        }
    }
    @Synchronized fun cancel() { if (enabled) mutable.value = ScannerState(ScannerStatus.CANCELLED, "Scan cancelled — nothing submitted") }
    @Synchronized fun unavailable(reason: String) {
        mutable.value = ScannerState(ScannerStatus.UNAVAILABLE, reason)
        notices.tryEmit(ScannerNotice(ScannerStatus.UNAVAILABLE, reason))
    }
}
