package com.ayrovi.worker.scanner

/** Android adapter boundary. Legacy callback retained so there is still only ONE scan guard. */
class ScanCoordinator(
    private val onAccepted: (value: String, fromOcr: Boolean, source: String) -> Unit,
    private val onRejected: (reason: String) -> Unit,
    val manager: ScannerManager = ScannerManager(initiallyEnabled = true),
    private val onResult: ((ScanResult) -> Unit)? = null,
) {
    fun onScanned(raw: String, fromOcr: Boolean, source: String = "CAMERA", symbology: ScanSymbology = ScanSymbology.UNKNOWN) {
        if (fromOcr) {
            // No live OCR acceptance: a format score is not an AYROVI product match.
            onRejected("OCR_REQUIRES_MANUAL_REVIEW")
            return
        }
        val scanSource = ScanSource.entries.firstOrNull { it.name == source } ?: run {
            onRejected("UNKNOWN_SCAN_SOURCE"); return
        }
        val result = manager.capture(raw, scanSource, symbology)
        if (result == null) onRejected(manager.state.value.detail)
        else if (onResult != null) onResult.invoke(result)
        else onAccepted(result.value, false, result.source.name)
    }

    fun reset() = manager.rearm()
    fun unavailable(reason: String) { manager.unavailable(reason); onRejected(reason) }
}
