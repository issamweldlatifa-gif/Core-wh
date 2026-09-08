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
 *
 * The pattern is the device-side mirror of the authoritative backend SKU
 * contract: the backend (receiving confirm endpoints) remains the FINAL
 * authority for whether a SKU exists — this shape only stops OCR noise from
 * being offered as a candidate.
 */
object CompactSkuTemplate : OcrTemplate {
    override val id: String = "COMPACT_SKU"
    override val label: String = "Product SKU"
    override val hint: String = "Point at the product SKU line"

    /**
     * Canonical compact SKU: `s` + one letter + 1..20 digits,
     * case-insensitive (s12..sb12345..SZ25092090066487374).
     */
    val SKU_PATTERN: Regex = Regex("(?i)^s[a-z][0-9]{1,20}$")

    /** True when a normalised token has the authoritative compact-SKU shape. */
    fun isCompactSku(token: String): Boolean = SKU_PATTERN.matches(token.trim())

    override fun score(token: String, baseConfidence: Double): Double? {
        if (!SKU_PATTERN.matches(token)) return null
        // Shape is exact, so a high floor confidence that stays under 1.0: OCR
        // is still a suggestion that must be confirmed / server-verified.
        return ((baseConfidence + 0.10).coerceAtMost(0.97) * 100).toInt() / 100.0
    }
}

/**
 * CARTON lane template: reads the identifiers printed on a Shipment Card
 * carton — the external carton id (e.g. `CTN-2026-000001`), a carton
 * reference (`SHP145-01`), a QR/barcode value, or the shipment tracking
 * number. It deliberately stays in the CARTON lane: it never accepts the
 * compact product-SKU shape (that belongs to the PRODUCT lane) so a product
 * label cannot confirm a carton and vice-versa.
 *
 * Like every template it only SCORES candidates — the device-side carton
 * matcher + backend `/receiving/home/carton` stay the authorities for whether
 * the read matches a dispatched carton card.
 */
object CartonTemplate : OcrTemplate {
    override val id: String = "CARTON"
    override val label: String = "Carton"
    override val hint: String = "Point at the carton / tracking label"

    // Carton identifiers are segmented shipping codes (CTN-…, SHP…-01), a
    // bare carton id (CTN…) or a carrier tracking run (letters+digits, 6+
    // chars). Pure quantities and bare dictionary words are rejected.
    private val segmented = Regex("^[A-Z0-9]*[A-Z][A-Z0-9]*[-_][A-Z0-9_-]{2,}$")
    private val trackingRun = Regex("^[A-Z0-9]{6,}$")

    override fun score(token: String, baseConfidence: Double): Double? {
        if (token.length < 5 || token.length > 48) return null
        if (token.all { it.isDigit() }) return null                 // a quantity, never a carton id
        if (CompactSkuTemplate.isCompactSku(token)) return null     // product SKU -> PRODUCT lane only
        val hasDigit = token.any { it.isDigit() }
        val hasLetter = token.any { it.isLetter() }
        if (!hasLetter) return null
        return when {
            // Explicit carton prefix — segmented CTN-… or bare CTN2026000001 —
            // is the strongest carton evidence.
            token.startsWith("CTN") ->
                ((baseConfidence + 0.12).coerceAtMost(0.97) * 100).toInt() / 100.0
            segmented.matches(token) && hasDigit ->
                ((baseConfidence + 0.08).coerceAtMost(0.96) * 100).toInt() / 100.0
            // Long letter+digit runs look like carrier tracking numbers.
            trackingRun.matches(token) && hasDigit ->
                ((baseConfidence + 0.04).coerceAtMost(0.92) * 100).toInt() / 100.0
            else -> null
        }
    }
}
