package com.ayrovi.worker.scanner

/**
 * The outcome of reading one OCR text block through a template. The candidate
 * is a SUGGESTION: [confirmed] is false until the operator explicitly accepts
 * it in the review UI, and only a confirmed result may be submitted.
 */
data class DirectedOcrResult(
    val templateId: String,
    val candidate: String?,
    val confidence: Double, // 0..1, 0 when there is no candidate
    val alternatives: List<String> = emptyList(),
    val linesRead: Int = 0,
    val confirmed: Boolean = false,
) {
    /** Operator pressed confirm in the review UI. Stays unconfirmed without a candidate. */
    fun confirmedByOperator(): DirectedOcrResult = copy(confirmed = candidate != null)
}

/**
 * Runs an [OcrTemplate] over raw OCR text (pure logic, fully unit-testable).
 *
 * Multi-line blocks are read line by line, so a label like
 *
 *     AYROVI LOGISTICS
 *     SKU-TEST-001
 *     QTY 24
 *
 * yields SKU-TEST-001 (the segmented line wins over the bare words and the
 * quantity is rejected outright) instead of one merged noisy string.
 */
class DirectedOcr(
    private val template: OcrTemplate = SkuTemplate,
    private val normalizer: OcrNormalizer = OcrNormalizer(),
    private val minConfidence: Double = 0.8,
) {
    fun read(block: String): DirectedOcrResult {
        val lines = block.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val scored = lines.flatMap { line ->
            val normalised = normalizer.normalise(line)
            normalizer.candidates(normalised).mapNotNull { candidate ->
                template.score(candidate.token, candidate.confidence)?.let { Scored(candidate.token, it) }
            }
        }.sortedByDescending { it.confidence }
        val best = scored.firstOrNull { it.confidence >= minConfidence }
        val alternatives = scored.map { it.token }.distinct().filter { it != best?.token }.take(3)
        return DirectedOcrResult(
            templateId = template.id,
            candidate = best?.token,
            confidence = best?.confidence ?: 0.0,
            alternatives = alternatives,
            linesRead = lines.size,
        )
    }

    private data class Scored(val token: String, val confidence: Double)
}
