package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.CardMatcher

/** Test doubles ONLY. No mock repository/data is included in the application. */
internal class MemorySessions : SessionStorage {
    private var current = SessionSnapshot(0, null)
    override val deviceCode = "AYROVI-TEST-DEVICE"
    override var employeeCode: String? = null
    @Synchronized override fun snapshot() = current
    @Synchronized override fun replace(expectedVersion: Long, tokens: AuthTokens, newLogin: Boolean): Boolean {
        if (current.version != expectedVersion) return false
        current = SessionSnapshot(current.version + 1, tokens, current.identityVersion + if (newLogin) 1 else 0)
        return true
    }
    @Synchronized override fun clear() { current = SessionSnapshot(current.version + 1, null, current.identityVersion + 1); employeeCode = null }
    @Synchronized override fun clearIfVersion(expectedVersion: Long): Boolean {
        if (current.version != expectedVersion) return false
        clear(); return true
    }
    @Synchronized override fun clearIfIdentity(expectedIdentity: Long): Boolean {
        if (current.identityVersion != expectedIdentity) return false
        clear(); return true
    }
    fun signIn(access: String = "old-access", refresh: String = "old-refresh") { replace(snapshot().version, AuthTokens(access, refresh), newLogin = true) }
}

internal class MemoryJournal : MutationJournal {
    var value: PendingMutation? = null
    var failRecording = false
    override fun read() = value
    override fun record(mutation: PendingMutation) {
        check(!failRecording) { "Storage unavailable" }
        check(value == null || value?.id == mutation.id)
        value = mutation
    }
    override fun clear(id: String) { if (value?.id == id) value = null }
}

/**
 * Card-based receiving double. Product and carton card data are the SAME
 * objects the device-side CardMatcher sees; the confirm endpoints mutate
 * them the way the backend does (one unit per product confirm, carton status
 * RECEIVED, tally derived from the cards).
 */
internal class ReceivingBackend : ReceivingGateway {
    val calls = mutableListOf<String>()
    var current = session()
    var active: ReceivingSession? = null
    var productScanType: String? = null
    var productSource: String? = null
    var cartonScanType: String? = null
    var cartonSource: String? = null
    var mismatchCardType: String? = null
    var mismatchScanType: String? = null
    var confirmFailure: Exception? = null
    var mismatchFailure: Exception? = null
    var readFailure: Exception? = null
    var activeFailure: Exception? = null
    var startCalls = 0
    var productCalls = 0
    var cartonCalls = 0
    var mismatchCalls = 0
    var completionCalls = 0
    var flagCalls = 0

    override suspend fun arrivals(): List<ArrivalRow> { calls += "arrivals"; return listOf(ArrivalRow(id = "arrival", code = "WAR-001", customerName = "Test customer", cartons = 1, units = 2)) }
    override suspend fun receivingSession(sessionId: String): ReceivingSession { calls += "session"; readFailure?.let { throw it }; return current }
    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? { calls += "active:$arrivalIdOrCode"; activeFailure?.let { throw it }; return active }
    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession { startCalls++; calls += "start"; active = current; return current }

    override suspend fun confirmProduct(sessionId: String, identifier: String, identifierType: String, quantity: Int, operationId: String, source: String, startedAt: String?): ReceivingSession {
        calls += "confirm-product"; productCalls++; productScanType = identifierType; productSource = source
        confirmFailure?.let { throw it }
        val card = current.productCards.firstOrNull { CardMatcher.sameCode(identifier, it.sku) || CardMatcher.sameCode(identifier, it.reference) }
            ?: return current.copy(flash = FlashView(kind = "MISMATCH", cardType = "PRODUCT", code = identifier))
        if (card.received >= card.expected) return current.copy(flash = FlashView(kind = "CARD_ALREADY_COMPLETE", cardType = "PRODUCT", code = card.sku ?: identifier))
        val received = card.received + quantity
        current = current.copy(
            productCards = current.productCards.map {
                if (it.id != card.id) it else it.copy(
                    received = received, remaining = (it.expected - received).coerceAtLeast(0),
                    status = when { received >= it.expected -> "RECEIVED" else -> "PARTIALLY_RECEIVED" },
                )
            },
            tally = current.tally.copy(
                receivedUnits = current.tally.receivedUnits + quantity,
                receivedProducts = current.productCards.count { it.received >= it.expected },
                shortUnits = current.productCards.sumOf { (it.expected - it.received).coerceAtLeast(0) },
            ),
            flash = FlashView(kind = "MATCH", cardType = "PRODUCT", code = card.sku ?: identifier, sku = identifier, expected = card.expected, received = received),
        )
        return current
    }

    override suspend fun confirmCarton(sessionId: String, identifier: String, identifierType: String, operationId: String, source: String, startedAt: String?): ReceivingSession {
        calls += "confirm-carton"; cartonCalls++; cartonScanType = identifierType; cartonSource = source
        confirmFailure?.let { throw it }
        val card = current.cartonCards.firstOrNull {
            CardMatcher.sameCode(identifier, it.externalCartonId) || CardMatcher.sameCode(identifier, it.reference) ||
                CardMatcher.sameCode(identifier, it.qrCodeValue) || CardMatcher.sameCode(identifier, it.barcodeValue)
        } ?: current.cartonCards.firstOrNull { CardMatcher.sameCode(identifier, it.trackingNumber) }
        if (card == null) return current.copy(flash = FlashView(kind = "MISMATCH", cardType = "CARTON", code = identifier))
        if (card.status == "RECEIVED") return current.copy(flash = FlashView(kind = "CARD_ALREADY_COMPLETE", cardType = "CARTON", code = card.externalCartonId ?: identifier))
        current = current.copy(
            cartonCards = current.cartonCards.map { if (it.id != card.id) it else it.copy(status = "RECEIVED") },
            tally = current.tally.copy(receivedCartons = current.tally.receivedCartons + 1, missingCartons = (current.tally.missingCartons - 1).coerceAtLeast(0)),
            flash = FlashView(kind = "MATCH", cardType = "CARTON", code = card.externalCartonId ?: identifier),
        )
        return current
    }

    override suspend fun reportMismatch(sessionId: String, cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?): ReceivingSession {
        calls += "mismatch"; mismatchCalls++; mismatchCardType = cardType; mismatchScanType = identifierType
        mismatchFailure?.let { throw it }
        return current.copy(flash = FlashView(kind = "MISMATCH", cardType = cardType, code = identifier))
    }

    override suspend fun pauseSession(sessionId: String): ReceivingSession { calls += "pause"; current = current.copy(status = "PAUSED"); return current }
    override suspend fun resumeSession(sessionId: String): ReceivingSession { calls += "resume"; current = current.copy(status = "RECEIVING"); return current }
    override suspend fun completeSession(sessionId: String): ReceivingSession { calls += "complete"; completionCalls++; current = current.copy(status = "COMPLETED"); return current }
    override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession { calls += "flag:$reason"; flagCalls++; return current }
    override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession { calls += "resolve"; return current }

    companion object {
        fun session() = ReceivingSession(
            id = "session", code = "RCV-000201", status = "RECEIVING", startedAt = "2026-09-05T08:00:00Z",
            arrival = DetailArrival(id = "arrival", code = "WAR-001", customerName = "Test customer"),
            productCards = listOf(
                ProductCard(id = "line", sku = "Sku/a-01", reference = "REF-ONLY", productName = "A long test product name for a physical unit",
                    expected = 2, received = 0, remaining = 2, status = "EXPECTED", identifiers = listOf("SKU/A-01", "REF-ONLY")),
            ),
            cartonCards = listOf(
                CartonCard(id = "carton", externalCartonId = "CTN-001", reference = "REF-CTN-001", qrCodeValue = "QR-CTN-001", barcodeValue = "BC-CTN-001",
                    cartonNumber = 1, totalCartons = 1, trackingNumber = "TRK-001", senderName = "Sender Co",
                    weight = 12.0, weightUnit = "KG", status = "EXPECTED",
                    identifiers = listOf("CTN-001", "REF-CTN-001", "QR-CTN-001", "BC-CTN-001")),
            ),
            tally = ReceivingTally(expectedCartons = 1, receivedCartons = 0, expectedProducts = 1, receivedProducts = 0, expectedUnits = 2, receivedUnits = 0, openDiscrepancies = 0, shortUnits = 2, overageUnits = 0, unexpectedProducts = 0, missingCartons = 1),
        )
    }
}
