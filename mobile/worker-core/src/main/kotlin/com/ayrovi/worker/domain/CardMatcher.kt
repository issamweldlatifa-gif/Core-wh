package com.ayrovi.worker.domain

import com.ayrovi.worker.data.CartonCard
import com.ayrovi.worker.data.ProductCard

/**
 * DEVICE-SIDE CARD MATCHING — a deliberate mirror of the backend
 * `scan-normalizer` (normalizeScan / sameScanCode).
 *
 * The worker device downloads the expected CARD data with the session
 * (productCards / cartonCards) and compares scanned / OCR identifiers
 * locally before anything is confirmed. The backend remains the FINAL
 * authority (re-validation, persistence, state update, duplicate
 * protection, worker activity log) — the device verdict only decides
 * what the operator sees and whether an explicit CONFIRM is offered.
 *
 * Normalization contract (identical on both sides):
 *   1. trim leading/trailing whitespace
 *   2. strip CR / LF / TAB (scanner drivers append a line terminator)
 *   3. collapse internal whitespace runs to a single space
 *   4. comparison is case-insensitive; stored identifiers are never rewritten
 */
object CardMatcher {
    private val LINE_TERMINATORS = Regex("[\\r\\n\\t]")
    private val WHITESPACE_RUNS = Regex("\\s+")

    fun normalize(raw: String?): String {
        if (raw == null) return ""
        return raw.replace(LINE_TERMINATORS, " ").replace(WHITESPACE_RUNS, " ").trim()
    }

    fun sameCode(a: String?, b: String?): Boolean {
        val na = normalize(a).uppercase()
        val nb = normalize(b).uppercase()
        return na.isNotEmpty() && na == nb
    }

    /** PRODUCT card: SKU or reference (first-class identifiers), case-insensitive. */
    fun matchProduct(cards: List<ProductCard>, raw: String?): ProductCard? {
        val term = normalize(raw)
        if (term.isEmpty()) return null
        val termUp = term.uppercase()
        return cards.firstOrNull { card ->
            (card.identifiers.isNotEmpty() && card.identifiers.any { it == termUp }) ||
                sameCode(term, card.sku) || sameCode(term, card.reference)
        }
    }

    sealed class CartonVerdict {
        /** Exactly one open carton card matches (carton identifier or a tracking number). */
        class Card(val card: CartonCard, val matchedOn: String) : CartonVerdict()
        /** The matched carton (or the tracking's cartons) are all received -> completed card. */
        class AllReceived(val card: CartonCard) : CartonVerdict()
        /** A tracking number matches several open cartons -> scan the specific carton. */
        class Ambiguous(val tracking: String, val candidates: List<CartonCard>) : CartonVerdict()
        object NotMatched : CartonVerdict()
    }

    /**
     * CARTON card: carton external id / reference / QR / barcode first, then the
     * shipment-level TRACKING number (mirrors the backend confirmCarton order).
     */
    fun matchCarton(cards: List<CartonCard>, raw: String?): CartonVerdict {
        val term = normalize(raw)
        if (term.isEmpty()) return CartonVerdict.NotMatched
        val termUp = term.uppercase()
        val direct = cards.firstOrNull { c ->
            (c.identifiers.isNotEmpty() && c.identifiers.any { it == termUp }) ||
                sameCode(term, c.externalCartonId) || sameCode(term, c.reference) ||
                sameCode(term, c.qrCodeValue) || sameCode(term, c.barcodeValue)
        }
        if (direct != null) {
            if (direct.status == "RECEIVED") return CartonVerdict.AllReceived(direct)
            return CartonVerdict.Card(direct, when {
                sameCode(term, direct.externalCartonId) -> "CARTON ID"
                sameCode(term, direct.reference) -> "CARTON REFERENCE"
                sameCode(term, direct.qrCodeValue) -> "QR CODE"
                sameCode(term, direct.barcodeValue) -> "BARCODE"
                else -> "CARTON CARD"
            })
        }
        val tracked = cards.filter { sameCode(term, it.trackingNumber) }
        if (tracked.isEmpty()) return CartonVerdict.NotMatched
        val open = tracked.filter { it.status != "RECEIVED" }
        return when {
            open.isEmpty() -> CartonVerdict.AllReceived(tracked.first())
            open.size == 1 -> CartonVerdict.Card(open.first(), "TRACKING NUMBER")
            else -> CartonVerdict.Ambiguous(tracked.first().trackingNumber ?: term, open)
        }
    }
}
