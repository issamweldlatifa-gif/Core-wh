package com.ayrovi.worker.scanner

/**
 * Android adapter boundary. Legacy callback retained so there is still only
 * ONE scan guard.
 *
 * OCR lane policy: the PRODUCT lane reads the strict compact-SKU shape, the
 * CARTON lane reads carton/tracking identifiers. Live camera text is never
 * submitted: it is shape-gated by the lane template, stabilised by a
 * multi-frame vote (one bad frame can never self-accept), and every candidate
 * still goes to the review UI for explicit operator confirmation. Hardware
 * (CT40/Zebra) and camera barcode scans bypass OCR entirely and pass straight
 * through the single [ScannerManager] guard.
 */
class ScanCoordinator(
    private val onAccepted: (value: String, fromOcr: Boolean, source: String) -> Unit,
    private val onRejected: (reason: String) -> Unit,
    val manager: ScannerManager = ScannerManager(initiallyEnabled = true),
    private val onResult: ((ScanResult) -> Unit)? = null,
    private val onOcrReview: ((block: String, result: DirectedOcrResult) -> Unit)? = null,
    /** Template applied to OCR blocks from the live camera / pasted text. */
    private val ocrTemplate: () -> OcrTemplate = { CompactSkuTemplate },
    /** Multi-frame vote for the live camera stream (unused for manual paste). */
    private val frameVote: OcrFrameVote = OcrFrameVote(),
) {
    private var activeTemplate: OcrTemplate = ocrTemplate()

    /** Live camera stream block: shape-gate + multi-frame vote, then review. */
    fun onOcrBlock(block: String) {
        // Live engine text is NEVER submitted here: readings that contain a
        // candidate go to the review UI, and the operator still confirms
        // every code. Blocks without a candidate keep scanning silently.
        val template = currentTemplate()
        val reading = DirectedOcr(template).read(block)
        val candidate = reading.candidate
        val locked = frameVote.observe(candidate)
        if (candidate != null && (locked != null || reading.confidence >= HIGH_CONFIDENCE)) {
            onOcrReview?.invoke(block, reading)
        }
    }

    /** Pasted/typed OCR text (manual entry): shape-gate only, no frame vote. */
    fun onOcrText(block: String): DirectedOcrResult =
        DirectedOcr(currentTemplate()).read(block)

    /** Resolve the live lane template; a lane change resets the frame vote. */
    private fun currentTemplate(): OcrTemplate {
        val t = ocrTemplate()
        if (t.id != activeTemplate.id) { activeTemplate = t; frameVote.reset() }
        return activeTemplate
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
        else {
            frameVote.reset()
            if (onResult != null) onResult.invoke(captured)
            else onAccepted(captured.value, false, captured.source.name)
        }
    }

    fun reset() { frameVote.reset(); manager.rearm() }
    fun unavailable(reason: String) { manager.unavailable(reason); onRejected(reason) }

    private companion object {
        // An exact-shape frame at/above this confidence is allowed to skip the
        // repeated-frame wait so a clean, steady label stays fast (Order §3:
        // "Do NOT make the worker wait unnecessarily").
        const val HIGH_CONFIDENCE = 0.95
    }
}
