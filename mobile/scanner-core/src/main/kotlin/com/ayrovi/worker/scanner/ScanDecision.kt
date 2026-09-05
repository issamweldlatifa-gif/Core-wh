package com.ayrovi.worker.scanner

/**
 * The single native input guard. Sliding repeat window prevents a held camera label from
 * re-firing every N seconds. Case/punctuation is identity, not something to 'correct'.
 */
class ScanDecision(private val windowMs: Long = 1500, private val debounceMs: Long = 400) {
    private var lastAcceptedRaw: String? = null
    private var lastAcceptedAt = 0L
    private var lastSeenAt = 0L

    @Synchronized fun evaluate(raw: String, nowMs: Long = System.nanoTime() / 1_000_000): ScanOutcome {
        val value = raw.trim()
        if (value.isEmpty()) return ScanOutcome.Rejected(RejectReason.EMPTY)
        // Technical transport bound, not a SKU-length/business rule. Preserve GS1 separators.
        if (value.length > 1024 || value.any { (it.code < 32 && it.code != 29) || it.code == 127 }) {
            return ScanOutcome.Rejected(RejectReason.INVALID)
        }
        if (lastAcceptedRaw != null) {
            if (value == lastAcceptedRaw && nowMs - lastSeenAt < windowMs) {
                lastSeenAt = nowMs
                return ScanOutcome.Rejected(RejectReason.DUPLICATE)
            }
            if (nowMs - lastAcceptedAt < debounceMs) return ScanOutcome.Rejected(RejectReason.DEBOUNCED)
        }
        lastAcceptedRaw = value
        lastAcceptedAt = nowMs
        lastSeenAt = nowMs
        return ScanOutcome.Accepted(value)
    }

    @Synchronized fun observeWhileDisabled(raw: String, nowMs: Long) {
        if (raw.trim() == lastAcceptedRaw) lastSeenAt = nowMs
    }

    @Synchronized fun reset() { lastAcceptedRaw = null; lastAcceptedAt = 0; lastSeenAt = 0 }
}

sealed class ScanOutcome {
    data class Accepted(val value: String) : ScanOutcome()
    data class Rejected(val reason: RejectReason) : ScanOutcome()
}
enum class RejectReason { EMPTY, DEBOUNCED, DUPLICATE, INVALID }
