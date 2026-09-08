package com.ayrovi.worker

import com.ayrovi.worker.data.*

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
 * RECEIVING HOME double. The PRODUCT and CARTON card data are the SAME
 * objects the device-side CardMatcher sees; the home confirm endpoints mutate
 * them the way the backend does (one unit per product confirm, carton status
 * RECEIVED, counters derived from the remaining cards).
 */
internal class HomeBackend : ReceivingGateway {
    val calls = mutableListOf<String>()
    var productCards = mutableListOf(
        ProductCard(id = "line", sku = "SKU/A-01", reference = "REF-ONLY", productName = "Test product",
            expected = 2, received = 0, remaining = 2, status = "EXPECTED", identifiers = listOf("SKU/A-01", "REF-ONLY")),
    )
    var cartonCards = mutableListOf(
        CartonCard(id = "carton", externalCartonId = "CTN-001", reference = "REF-CTN-001",
            qrCodeValue = "QR-CTN-001", barcodeValue = "BC-CTN-001",
            cartonNumber = 1, totalCartons = 1, trackingNumber = "TRK-001", senderName = "Sender Co",
            weight = 12.0, weightUnit = "KG", status = "EXPECTED",
            identifiers = listOf("CTN-001", "REF-CTN-001", "QR-CTN-001", "BC-CTN-001", "TRK-001")),
    )
    var homeFailures = 0
    var confirmFailure: Exception? = null
    /** Push tokens the backend was told about, and a switch to simulate an outage. */
    val registeredTokens = mutableListOf<String>()
    val unregisteredTokens = mutableListOf<String>()
    var pushFailure: Exception? = null

    override suspend fun registerPushToken(token: String, platform: String, deviceId: String?) {
        calls += "register-push"
        pushFailure?.let { throw it }
        registeredTokens += token
    }

    override suspend fun unregisterPushToken(token: String) {
        calls += "unregister-push"
        pushFailure?.let { throw it }
        unregisteredTokens += token
    }

    private fun feed(): ReceivingHome = ReceivingHome(
        productCards = productCards.filter { it.received < it.expected },
        cartonCards = cartonCards.filter { it.status != "RECEIVED" },
        productCardsPending = productCards.count { it.received < it.expected },
        cartonCardsPending = cartonCards.count { it.status != "RECEIVED" },
        productList = productCards.mapNotNull { p ->
            if (p.received >= p.expected) null else HomeProductRow("WAR-001", p.sku ?: p.reference, p.productName, p.remaining)
        },
        cartonList = cartonCards.mapNotNull { c ->
            if (c.status == "RECEIVED") null else HomeCartonRow("WAR-001", c.externalCartonId, c.trackingNumber, 1)
        },
    )

    override suspend fun receivingHome(): ReceivingHome { calls += "home"; return feed() }

    override suspend fun homeConfirmProduct(
        identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        calls += "home-product"
        confirmFailure?.let { throw it }
        val card = productCards.firstOrNull {
            com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.sku) ||
                com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.reference)
        } ?: return HomeScanResult(ok = false, flash = FlashView(kind = "MISMATCH", cardType = "PRODUCT", code = identifier), home = feed())
        if (card.received >= card.expected) return HomeScanResult(ok = true,
            flash = FlashView(kind = "CARD_ALREADY_COMPLETE", cardType = "PRODUCT", code = card.sku), home = feed())
        val received = card.received + quantity
        productCards = productCards.map {
            if (it.id != card.id) it else it.copy(received = received, remaining = (it.expected - received).coerceAtLeast(0),
                status = if (received >= it.expected) "RECEIVED" else "PARTIALLY_RECEIVED")
        }.toMutableList()
        return HomeScanResult(ok = true, sessionId = "session",
            flash = FlashView(kind = "MATCH", cardType = "PRODUCT", code = card.sku ?: identifier, expected = card.expected, received = received),
            home = feed())
    }

    override suspend fun homeConfirmCarton(
        identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        calls += "home-carton"
        confirmFailure?.let { throw it }
        val card = cartonCards.firstOrNull {
            com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.externalCartonId) ||
                com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.reference) ||
                com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.qrCodeValue) ||
                com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.barcodeValue) ||
                com.ayrovi.worker.domain.CardMatcher.sameCode(identifier, it.trackingNumber)
        } ?: return HomeScanResult(ok = false, flash = FlashView(kind = "MISMATCH", cardType = "CARTON", code = identifier), home = feed())
        if (card.status == "RECEIVED") return HomeScanResult(ok = true,
            flash = FlashView(kind = "CARD_ALREADY_COMPLETE", cardType = "CARTON", code = card.externalCartonId), home = feed())
        cartonCards = cartonCards.map { if (it.id != card.id) it else it.copy(status = "RECEIVED") }.toMutableList()
        return HomeScanResult(ok = true, sessionId = "session",
            flash = FlashView(kind = "MATCH", cardType = "CARTON", code = card.externalCartonId), home = feed())
    }

    override suspend fun homeMismatch(
        cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?,
    ): HomeScanResult { calls += "home-mismatch"; return HomeScanResult(ok = true, flash = FlashView(kind = "MISMATCH", cardType = cardType, code = identifier), home = feed()) }

    // Legacy session contract — not used by the home flow.
    override suspend fun arrivals() = listOf(ArrivalRow(id = "arrival", code = "WAR-001"))
    override suspend fun receivingSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? = throw UnsupportedOperationException()
    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun confirmProduct(sessionId: String, identifier: String, identifierType: String, quantity: Int, operationId: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun confirmCarton(sessionId: String, identifier: String, identifierType: String, operationId: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun reportMismatch(sessionId: String, cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun pauseSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun resumeSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun completeSession(sessionId: String): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession = throw UnsupportedOperationException()
    override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession = throw UnsupportedOperationException()
}
