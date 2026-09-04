package com.ayrovi.worker.scanner

/**
 * Pure, station-agnostic scan decision logic.
 * Camera and ML Kit adapters belong outside this module; the Warehouse API
 * remains the authority for accepting an operation.
 */
data class ScanCandidate(
    val rawValue: String,
    val source: ScanSource,
    val detectedAtEpochMs: Long,
)

enum class ScanSource { QR, BARCODE, OCR, MANUAL }

sealed interface ScanDecision {
    data class Accepted(val value: String) : ScanDecision
    data class Duplicate(val value: String) : ScanDecision
    data class Empty(val reason: String = "EMPTY_SCAN") : ScanDecision
}

class ScanDeduplicator(private val debounceMs: Long = 900L) {
    private var lastValue: String? = null
    private var lastAt: Long = Long.MIN_VALUE

    fun decide(candidate: ScanCandidate): ScanDecision {
        val value = candidate.rawValue.trim()
        if (value.isEmpty()) return ScanDecision.Empty()
        val sameRead = value.equals(lastValue, ignoreCase = true)
        if (sameRead && candidate.detectedAtEpochMs - lastAt < debounceMs) {
            return ScanDecision.Duplicate(value)
        }
        lastValue = value
        lastAt = candidate.detectedAtEpochMs
        return ScanDecision.Accepted(value)
    }
}
