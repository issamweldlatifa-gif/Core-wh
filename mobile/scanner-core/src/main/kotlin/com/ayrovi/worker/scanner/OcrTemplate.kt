package com.ayrovi.worker.scanner

/**
 * A directed-OCR template: WHAT the operator is trying to read off a label.
 *
 * The OCR engine (ML Kit text, a pasted block, typed text) only supplies raw
 * text; the template scores normalised candidate tokens for one domain shape.
 * Templates never accept on their own — every result still needs an explicit
 * operator confirm (see [DirectedOcrResult.confirmedByOperator]) before it
 * may be submitted as a reviewed code.
 */
interface OcrTemplate {
    val id: String
    val label: String
    /** Short operator hint shown in the review UI, e.g. "Point at the SKU line". */
    val hint: String

    /**
     * Template confidence for a normalised token (0..1), or null to reject it.
     * Base shape scoring comes from [OcrNormalizer]; the template applies
     * domain shaping on top. Never returns 1.0: OCR is a suggestion, never a
     * product match.
     */
    fun score(token: String, baseConfidence: Double): Double?
}

/**
 * SKU template: reads product/carton codes off printed labels.
 *
 * Accepts structured tokens (segmented with '-'/'_', or long alphanumeric
 * runs); rejects quantities (pure digits), short noise and merged garbage.
 */
object SkuTemplate : OcrTemplate {
    override val id: String = "SKU"
    override val label: String = "SKU"
    override val hint: String = "Point at the SKU line"

    override fun score(token: String, baseConfidence: Double): Double? {
        // Template is stricter than the raw tokeniser: 3-char tokens are
        // noise-prone on real labels, quantities are never codes.
        if (token.length < 4 || token.length > 40) return null
        if (token.all { it.isDigit() }) return null
        val hasLetter = token.any { it.isLetter() }
        val hasDigit = token.any { it.isDigit() }
        val segmented = token.contains('-') || token.contains('_')
        return when {
            // Segmented codes (AYROVI-RCV-0099, SKU-TEST-001) are the SKU shape.
            segmented && hasLetter -> (baseConfidence + 0.05).coerceAtMost(0.97)
            // Long letter+digit runs without separators still look like codes.
            hasLetter && hasDigit -> (baseConfidence + 0.03).coerceAtMost(0.95)
            // Bare words (CARTON, DAMAGED) or digit runs with dashes
            // (dates, quantities) are weak evidence for a SKU.
            hasLetter -> baseConfidence * 0.9
            else -> baseConfidence * 0.75
        }.let { (it * 100).toInt() / 100.0 }
    }
}

/**
 * Strict product-SKU template for the warehouse's compact code shape:
 *
 *     `s` + one letter + 1..20 digits        e.g. sb25092090066487374, sz123
 *
 * This is the shape the operator reads off a label and matches against an
 * expected card line, so the template is deliberately STRICT: it accepts only
 * that exact shape and rejects everything else (quantities, bare words,
 * segmented warehouse codes, merged garbage). Strictness is what lets an OCR
 * read become a confident, local match instead of a per-scan "not found".
 *
 * Comparison is case-insensitive (the OCR normalizer uppercases reads and the
 * matcher compares case-insensitively), so `SB25092090066487374` reads are
 * accepted too — a floor scan must not fail on case.
 */
object CompactSkuTemplate : OcrTemplate {
    override val id: String = "COMPACT_SKU"
    override val label: String = "Product SKU"
    override val hint: String = "Point at the product SKU line"

    /** `s` + one letter + 1..20 digits, case-insensitive. */
    private val compactSku = Regex("(?i)^s[a-z][0-9]{1,20}$")

    override fun score(token: String, baseConfidence: Double): Double? {
        if (!compactSku.matches(token)) return null
        // Shape is exact, so a high floor confidence that stays under 1.0: OCR
        // is still a suggestion that must be confirmed / server-verified.
        return ((baseConfidence + 0.10).coerceAtMost(0.97) * 100).toInt() / 100.0
    }
}
