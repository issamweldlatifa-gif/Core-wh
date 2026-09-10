package com.ayrovi.worker.scanner

/**
 * AUTO scan template (HOME "QR CODE" / OCR tool, UX RESTRUCTURE §9/§14).
 *
 * Pure COMPOSITION of the two existing lane templates — zero new scoring
 * logic and no widened shapes:
 *
 *   - the compact product-SKU shape is tried exactly as the PRODUCT lane
 *     scores it (case-preserving, §18 pattern untouched);
 *   - everything else is scored exactly as the CARTON lane scores it
 *     (uppercased, carton/tracking shapes untouched).
 *
 * Every template rule still applies: a score is only a SUGGESTION, the
 * operator confirms it, and the device matchers + backend remain the only
 * authorities that can confirm a card. The template is used ONLY by the
 * AUTO tool; the dedicated PRODUCT / CARTON lanes keep their own templates
 * and their lane-purity guarantees.
 */
object AutoScanTemplate : OcrTemplate {
    override val id: String = "AUTO_SCAN"
    override val label: String = "Product / Carton"
    override val hint: String = "Point at the product SKU or carton / tracking label"

    /**
     * Case-preserving like the PRODUCT lane: the compact-SKU shape is
     * case-sensitive, so the read must reach this template exactly as
     * printed. Carton identifiers are case-insensitive, so they are
     * uppercased here before the CARTON template scores them.
     */
    override val caseSensitive: Boolean = true

    override fun score(token: String, baseConfidence: Double): Double? {
        // 1) Exact compact-SKU shape (PRODUCT lane rule, untouched).
        CompactSkuTemplate.score(token, baseConfidence)?.let { return it }
        // 2) Carton / tracking shapes (CARTON lane rule, untouched) on the
        //    uppercased token — never a product SKU: CartonTemplate still
        //    refuses the reserved SKU shape in any case.
        return CartonTemplate.score(token.uppercase(), baseConfidence)
    }
}
