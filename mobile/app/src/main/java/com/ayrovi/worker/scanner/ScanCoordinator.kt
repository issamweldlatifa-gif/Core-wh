package com.ayrovi.worker.scanner

/** Android adapter boundary. Legacy callback retained so there is still only ONE scan guard. */
class ScanCoordinator(
    private val onAccepted: (value: String, fromOcr: Boolean, source: String) -> Unit,
    private val onRejected: (reason: String) -> Unit,
    val manager: ScannerManager = ScannerManager(initiallyEnabled = true),
    private val onResult: ((ScanResult) -> Unit)? = null,
    private val onOcrReview: ((block: String, result: DirectedOcrResult) -> Unit)? = null,
) {
    fun onOcrBlock(block: String, template: OcrTemplate = CompactSkuTemplate) {
        // Live engine text is NEVER submitted here: readings that contain a
        // candidate go to the review UI, and the operator still confirms
        // every code. Blocks without a candidate keep scanning silently.
        val reading = DirectedOcr(template).read(block)
        if (reading.candidate != null) onOcrReview?.invoke(block, reading)
    }

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

    fun onOcrConfirmed(result: DirectedOcrResult) {
        // Reviewed OCR only: raw engine text still goes through onScanned and
        // is rejected there. A confirmed candidate is operator-accepted text
        // from the EXISTING OCR pipeline, so it submits through the same
        // single scan guard, tagged OCR so the backend can record
        // identifierType=OCR in the worker activity log.
        val code = result.takeIf { it.confirmed }?.candidate
        if (code == null) { onRejected("OCR_REQUIRES_MANUAL_REVIEW"); return }
        val captured = manager.capture(code, ScanSource.OCR, ScanSymbology.UNKNOWN)
        if (captured == null) onRejected(manager.state.value.detail)
        else if (onResult != null) onResult.invoke(captured)
        else onAccepted(captured.value, false, captured.source.name)
    }

    fun reset() = manager.rearm()
    fun unavailable(reason: String) { manager.unavailable(reason); onRejected(reason) }
}
