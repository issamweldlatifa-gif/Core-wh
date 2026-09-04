package com.ayrovi.worker.scanner

import java.util.concurrent.atomic.AtomicBoolean

/**
 * App-side coordinator bridging raw camera/OCR output to scanner-core
 * decisions (same package — scanner-core holds the pure logic). A single
 * coordinator powers every station UI:
 *
 *   raw value -> ScanDecision (duplicate/debounce/empty)
 *   barcode/QR values pass straight through
 *   OCR text is normalised + scored by OcrNormalizer before acceptance
 *   -> accepted values are delivered to the station handler
 *
 * [onAccepted] receives only values that passed all guards; [onRejected]
 * receives the reason so the UI can flash the outcome to the operator.
 */
class ScanCoordinator(
    private val onAccepted: (value: String, fromOcr: Boolean, source: String) -> Unit,
    private val onRejected: (reason: String) -> Unit,
) {
    private val decision = ScanDecision()
    private val ocr = OcrNormalizer()
    private val busy = AtomicBoolean(false)

    /**
     * @param source input device label reported to the warehouse API —
     *   "CAMERA" (phone camera), HoneywellScanner.SOURCE ("EXTERNAL_SCANNER"
     *   for the CT40 side trigger) or "MANUAL".
     */
    fun onScanned(raw: String, fromOcr: Boolean, source: String = "CAMERA") {
        if (!busy.compareAndSet(false, true)) return // one decision at a time
        try {
            when (val outcome = decision.evaluate(raw)) {
                is ScanOutcome.Accepted -> {
                    if (fromOcr) {
                        // Never accept raw OCR text — only a scored candidate.
                        val best = ocr.bestCandidate(outcome.value)
                        if (best != null) onAccepted(best.token, true, source)
                        else onRejected("OCR_LOW_CONFIDENCE")
                    } else {
                        onAccepted(outcome.value, false, source)
                    }
                }
                is ScanOutcome.Rejected -> onRejected(outcome.reason.name)
            }
        } finally {
            busy.set(false)
        }
    }

    fun reset() = decision.reset()
}
