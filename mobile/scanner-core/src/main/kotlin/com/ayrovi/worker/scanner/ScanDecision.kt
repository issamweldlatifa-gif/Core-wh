package com.ayrovi.worker.scanner

/**
 * Pure scan-decision logic shared by every station (Receiving, Sorting,
 * Packing, Shipping...). One engine for the whole warehouse — stations only
 * supply the workflow that consumes a decision.
 *
 * Responsibilities:
 *  - duplicate prevention (the same raw value cannot be accepted twice in a
 *    `windowMs` — e.g. an operator holding a trigger or a re-focus),
 *  - debounce (a result is only accepted after `debounceMs` from the previous
 *    accepted scan),
 *  - barcode/QR pass-through vs OCR text.
 */
class ScanDecision(
    private val windowMs: Long = 1500,
    private val debounceMs: Long = 400,
) {
    private var lastAcceptedRaw: String? = null
    private var lastAcceptedAt: Long = 0

    /**
     * Evaluate a raw scanner/OCR value arriving at `nowMs`.
     *
     * @return OK(accept) or a reject reason. The caller flashes the outcome
     * to the operator; only OK results reach the warehouse API.
     */
    fun evaluate(raw: String, nowMs: Long = System.currentTimeMillis()): ScanOutcome {
        val value = raw.trim()
        if (value.isEmpty()) return ScanOutcome.Rejected(RejectReason.EMPTY)

        val sinceLast = nowMs - lastAcceptedAt
        if (sinceLast < debounceMs) {
            return ScanOutcome.Rejected(RejectReason.DEBOUNCED)
        }
        if (lastAcceptedRaw != null && value == lastAcceptedRaw && sinceLast < windowMs) {
            return ScanOutcome.Rejected(RejectReason.DUPLICATE)
        }
        lastAcceptedRaw = value
        lastAcceptedAt = nowMs
        return ScanOutcome.Accepted(value)
    }

    /** Reset the guard (e.g. when the operator switches workflows). */
    fun reset() {
        lastAcceptedRaw = null
        lastAcceptedAt = 0
    }
}

sealed class ScanOutcome {
    data class Accepted(val value: String) : ScanOutcome()
    data class Rejected(val reason: RejectReason) : ScanOutcome()
}

enum class RejectReason {
    EMPTY,
    DEBOUNCED,
    DUPLICATE,
}
