package com.ayrovi.worker.data

/**
 * Temporary Storage station contract — implemented by WorkerRepository.
 * Same rule as ReceivingGateway: the device never decides; the backend
 * (/v1/temporary-storage) resolves customer -> section -> target container,
 * validates the scanned container and persists the unit. Worker UI only
 * renders what the server says and highlights the designated container.
 */
interface TemporaryStorageGateway {
    /** Station home: header counters + ACTIVE dynamic sections (real data). */
    suspend fun tsHome(): TsHomePayload
    /** One section board: customer batches + container cards (qty/capacity/status). */
    suspend fun tsSection(letter: String): TsSectionPayload
    /** Scan a product: server returns the target container (advisory; /place is final). */
    suspend fun tsScanProduct(code: String, operationId: String): TsScanPayload
    /** Scan the product + container: server stores or rejects (WRONG/FULL/REVIEW/CARTON). */
    suspend fun tsPlace(code: String, containerCode: String, operationId: String): TsPlacePayload
    /** Unknown/problem unit -> Review lane (REVIEW row + exception + admin alert). */
    suspend fun tsReview(code: String, reason: String, operationId: String): TsReviewPayload
    /** Rapport de Fin -> Admin Reports. */
    suspend fun tsReportFin(observation: String?): TsReportPayload
}
