package com.ayrovi.worker.data

/**
 * Card-based receiving contract (device-side matching rebuild), implemented once by
 * WorkerRepository; no UI/network dependency.
 *
 * The device matches the scanned identifier against its expected card data FIRST
 * (CardMatcher); these confirm endpoints are the backend's FINAL validation,
 * persistence, state update, duplicate/conflict protection and the worker
 * activity log. A mismatch never confirms and is logged as a failure.
 */
interface ReceivingGateway {
    /** RECEIVING HOME feed: cards dispatched to this worker + live counters. */
    suspend fun receivingHome(): ReceivingHome
    /** PRODUCT scan from Receiving Home (backend auto-resolves the session). */
    suspend fun homeConfirmProduct(
        identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String? = null,
    ): HomeScanResult
    /** CARTON scan from Receiving Home (backend auto-resolves the session). */
    suspend fun homeConfirmCarton(
        identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String? = null,
    ): HomeScanResult
    /**
     * Register this device's push token so the backend can reach the handset
     * with NEW_RECEIVING_CARD while the app is backgrounded or closed.
     * Idempotent per token; safe to call on every authenticated start.
     */
    suspend fun registerPushToken(token: String, platform: String = "ANDROID", deviceId: String? = null)

    /** Drop the push token on logout so a signed-out phone stops receiving cards. */
    suspend fun unregisterPushToken(token: String)

    /** Device-side MISMATCH from Receiving Home (nothing confirmed/completed). */
    suspend fun homeMismatch(
        cardType: String, identifier: String,
        identifierType: String, source: String, startedAt: String? = null,
    ): HomeScanResult

    suspend fun arrivals(): List<ArrivalRow>
    suspend fun receivingSession(sessionId: String): ReceivingSession
    suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession?
    suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession

    /** PRODUIT lane: confirm a PRODUCT card matched on the device (QR / barcode / OCR SKU / reference). */
    suspend fun confirmProduct(
        sessionId: String, identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String? = null,
    ): ReceivingSession

    /** CARTON lane: confirm a CARTON card matched on the device (carton ref / QR / barcode / tracking). */
    suspend fun confirmCarton(
        sessionId: String, identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String? = null,
    ): ReceivingSession

    /** Device-side MISMATCH: log the failure; nothing is confirmed, nothing completes. */
    suspend fun reportMismatch(
        sessionId: String, cardType: String, identifier: String,
        identifierType: String, source: String, startedAt: String? = null,
    ): ReceivingSession

    suspend fun pauseSession(sessionId: String): ReceivingSession
    suspend fun resumeSession(sessionId: String): ReceivingSession
    suspend fun completeSession(sessionId: String): ReceivingSession
    suspend fun flagSession(sessionId: String, reason: String, sku: String? = null, code: String? = null): ReceivingSession
    suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession
}
