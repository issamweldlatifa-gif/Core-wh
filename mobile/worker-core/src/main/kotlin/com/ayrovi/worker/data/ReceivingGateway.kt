package com.ayrovi.worker.data

/** Existing backend contract, implemented once by WorkerRepository; no UI/network dependency. */
interface ReceivingGateway {
    suspend fun arrivals(): List<ArrivalRow>
    suspend fun receivingSession(sessionId: String): ReceivingSession
    suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession?
    suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession
    suspend fun scanCarton(sessionId: String, code: String, scanType: String, operationId: String, source: String): ReceivingSession
    suspend fun receiveCarton(sessionId: String, cartonId: String, operationId: String, source: String): ReceivingSession
    suspend fun container(code: String): OpContainerDetail
    suspend fun scanArticleAtReceiving(sessionId: String, sku: String, containerCode: String, cartonCode: String? = null, operationId: String? = null): ArticleScanResult
    suspend fun pauseSession(sessionId: String): ReceivingSession
    suspend fun resumeSession(sessionId: String): ReceivingSession
    suspend fun completeSession(sessionId: String): ReceivingSession
    suspend fun flagSession(sessionId: String, reason: String, sku: String? = null, code: String? = null): ReceivingSession
    suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession
}
