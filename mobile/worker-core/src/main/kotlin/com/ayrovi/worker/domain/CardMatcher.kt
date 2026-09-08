package com.ayrovi.worker.domain

import com.ayrovi.worker.data.CartonCard
import com.ayrovi.worker.data.ProductCard

/**
 * DEVICE-SIDE CARD MATCHING — a deliberate mirror of the backend
 * `scan-normalizer` (normalizeScan / sameScanCode).
 *
 * CARTON FIX:
 * - Carton is always CARTON entity, never PRODUCT, even if it contains SKU
 * - Preserve suivi_code, tracking_code, QR, barcode as identifiers
 * - Match against suivi_code and tracking_code as well
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
     * CARTON card: carton external id / reference / QR / barcode / suivi / tracking first, then the
     * shipment-level TRACKING number (mirrors the backend confirmCarton order).
     * CARTON FIX: preserve carton identity, do NOT match SKU as carton
     */
    fun matchCarton(cards: List<CartonCard>, raw: String?): CartonVerdict {
        val term = normalize(raw)
        if (term.isEmpty()) return CartonVerdict.NotMatched
        val termUp = term.uppercase()
        val direct = cards.firstOrNull { c ->
            (c.identifiers.isNotEmpty() && c.identifiers.any { it == termUp }) ||
                sameCode(term, c.externalCartonId) || sameCode(term, c.reference) ||
                sameCode(term, c.qrCodeValue) || sameCode(term, c.barcodeValue) ||
                sameCode(term, c.suiviCode) || sameCode(term, c.trackingCode) ||
                sameCode(term, c.trackingNumber)
        }
        if (direct != null) {
            if (direct.status == "RECEIVED") return CartonVerdict.AllReceived(direct)
            return CartonVerdict.Card(direct, when {
                sameCode(term, direct.externalCartonId) -> "CARTON ID"
                sameCode(term, direct.reference) -> "CARTON REFERENCE"
                sameCode(term, direct.qrCodeValue) -> "QR CODE"
                sameCode(term, direct.barcodeValue) -> "BARCODE"
                sameCode(term, direct.suiviCode) -> "SUIVI CODE"
                sameCode(term, direct.trackingCode) -> "TRACKING CODE"
                sameCode(term, direct.trackingNumber) -> "TRACKING NUMBER"
                else -> "CARTON CARD"
            })
        }
        val tracked = cards.filter { 
            sameCode(term, it.trackingNumber) || sameCode(term, it.suiviCode) || sameCode(term, it.trackingCode)
        }
        if (tracked.isEmpty()) return CartonVerdict.NotMatched
        val open = tracked.filter { it.status != "RECEIVED" }
        return when {
            open.isEmpty() -> CartonVerdict.AllReceived(tracked.first())
            open.size == 1 -> CartonVerdict.Card(open.first(), "TRACKING / SUIVI")
            else -> CartonVerdict.Ambiguous(tracked.first().trackingNumber ?: tracked.first().suiviCode ?: term, open)
        }
    }
}
