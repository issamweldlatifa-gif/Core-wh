package com.ayrovi.worker

import com.ayrovi.worker.data.*
import kotlinx.serialization.json.Json

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

internal class ReceivingBackend : ReceivingGateway {
    val calls = mutableListOf<String>()
    var current = session()
    var active: ReceivingSession? = null
    var cartonSource: String? = null
    var cartonScanType: String? = null
    var receivedSku: String? = null
    var receivedTote: String? = null
    var sourceCarton: String? = null
    var articleFailure: Exception? = null
    var articleReply: ArticleScanResult? = null
    var readFailure: Exception? = null
    var activeFailure: Exception? = null
    var unknownCarton = false
    var wrongShipment = false
    var tote = OpContainerDetail(code = "RCN-000001", type = "RECEIVING", status = "ACTIVE")
    var startCalls = 0
    var receiveCartonCalls = 0
    var articleCalls = 0
    var completionCalls = 0
    var flagCalls = 0

    override suspend fun arrivals(): List<ArrivalRow> { calls += "arrivals"; return listOf(ArrivalRow(id = "arrival", code = "WAR-001", customerName = "Test customer", cartons = 1, units = 2)) }
    override suspend fun receivingSession(sessionId: String): ReceivingSession { calls += "session"; readFailure?.let { throw it }; return current }
    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? { calls += "active:$arrivalIdOrCode"; activeFailure?.let { throw it }; return active }
    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession { startCalls++; calls += "start"; active = current; return current }
    override suspend fun scanCarton(sessionId: String, code: String, scanType: String, operationId: String, source: String): ReceivingSession {
        calls += "scan-carton"; cartonSource = source; cartonScanType = scanType
        return when {
            wrongShipment -> current.copy(flash = FlashView(kind = "WRONG_SHIPMENT"), discrepancies = listOf(DiscrepancyRow(type = "WRONG_SHIPMENT", status = "OPEN", reason = "Carton CTN-OTHER belongs to shipment SHP-OTHER")))
            unknownCarton -> current.copy(flash = FlashView(kind = "UNKNOWN_CARTON", code = code))
            current.tally.receivedCartons > 0 -> current.copy(flash = FlashView(kind = "DUPLICATE_CARTON", carton = Json.parseToJsonElement("\"CTN-001\"")))
            else -> current.copy(flash = FlashView(kind = "CARTON_IDENTIFIED", carton = Json.parseToJsonElement("""{"id":"carton-uuid","externalCartonId":"CTN-001"}""")))
        }
    }
    override suspend fun receiveCarton(sessionId: String, cartonId: String, operationId: String, source: String): ReceivingSession {
        calls += "receive-carton"; receiveCartonCalls++; cartonSource = source
        current = current.copy(receivedCartonEvents = listOf(CartonEvent(id = "event", code = "CTN-001", cartonId = "CTN-001", status = "RECEIVED")), tally = current.tally.copy(receivedCartons = 1, missingCartons = 0))
        return current
    }
    override suspend fun container(code: String): OpContainerDetail { calls += "container:$code"; return tote }
    override suspend fun scanArticleAtReceiving(sessionId: String, sku: String, containerCode: String, cartonCode: String?): ArticleScanResult {
        calls += "article"; articleCalls++; receivedSku = sku; receivedTote = containerCode; sourceCarton = cartonCode
        articleFailure?.let { throw it }
        current = current.copy(products = current.products.map { it.copy(received = 1, remaining = 1) }, tally = current.tally.copy(receivedUnits = 1, shortUnits = 1))
        return articleReply ?: ArticleScanResult(flash = FlashView(kind = "ARTICLE_RECEIVED", article = Json.parseToJsonElement("""{"code":"ART-00000001","sku":"Sku/a-01"}"""), container = containerCode), matched = true)
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
            products = listOf(ProductRow(id = "line", sku = "Sku/a-01", reference = "REF-ONLY", productName = "A long test product name for a physical unit", expected = 2, received = 0, remaining = 2, difference = -2)),
            tally = ReceivingTally(expectedCartons = 1, receivedCartons = 0, expectedProducts = 1, receivedProducts = 0, expectedUnits = 2, receivedUnits = 0, openDiscrepancies = 0, shortUnits = 2, overageUnits = 0, unexpectedProducts = 0, missingCartons = 1),
        )
    }
}
