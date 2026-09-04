package com.ayrovi.worker.scanner

/**
 * OCR text normalisation + extraction (pure logic, fully unit-testable).
 *
 * OCR engines return raw text; we never treat that text as a valid code on
 * its own. The pipeline:
 *
 *   raw text -> normalise (trim/uppercase/collapse whitespace)
 *   -> candidate tokens (codes shaped like AYROVI references)
 *   -> confidence scoring (exact shape wins, digits-only lower, noise lower)
 *   -> validation callbacks decide whether a candidate is "good enough"
 */
data class OcrCandidate(
    val token: String,
    val confidence: Double, // 0..1
)

class OcrNormalizer {

    /** Normalise raw OCR text into a clean uppercase, single-spaced string. */
    fun normalise(raw: String): String =
        raw
            .trim()
            // Pipe/bang are common misreads of the digit one (1 | !); letters
            // I/l are NOT mapped so real codes containing I stay intact.
            .replace(Regex("[|!]"), "1")
            .uppercase()
            .replace(Regex("[\\s\\t\\r\\n]+"), " ")
            .trim()

    /**
     * Extract candidate codes. A warehouse code token is 3..48 chars of
     * A-Z, 0-9, '-' or '_' that does not start/end with a separator.
     */
    fun candidates(normalised: String): List<OcrCandidate> {
        if (normalised.isEmpty()) return emptyList()
        val tokenPattern = Regex("(?<![A-Z0-9])[A-Z0-9][A-Z0-9_-]{2,47}(?![A-Z0-9])")
        return tokenPattern.findAll(normalised).map { m ->
            val token = m.value
            OcrCandidate(token, confidenceFor(token, normalised))
        }.sortedByDescending { it.confidence }.toList()
    }

    /** Score a candidate token inside its sentence context. */
    fun confidenceFor(token: String, sentence: String): Double {
        var score = 1.0
        // Whole-sentence match (the OCR read exactly one code) is the most
        // trustworthy case.
        if (token == sentence) score *= 1.0
        else score *= 0.85
        // Tokens that look like structured warehouse codes score higher.
        if (token.contains('-') || token.contains('_')) score *= 1.0 else score *= 0.9
        // Pure digits (a quantity, not a code) are suspicious as a code.
        if (token.matches(Regex("\\d{1,10}"))) score *= 0.6
        // Extremely long reads are usually merged noise.
        if (token.length > 40) score *= 0.7
        return (score * 100).toInt() / 100.0
    }

    /**
     * Best candidate passing `minConfidence`; null when OCR is too uncertain —
     * the caller then asks the operator to re-scan (never auto-accepts noise).
     */
    fun bestCandidate(raw: String, minConfidence: Double = 0.8): OcrCandidate? =
        candidates(normalise(raw)).firstOrNull { it.confidence >= minConfidence }
}
