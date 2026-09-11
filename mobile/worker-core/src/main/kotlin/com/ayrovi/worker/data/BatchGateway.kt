package com.ayrovi.worker.data

import kotlinx.serialization.Serializable

/**
 * AYROVI BATCH — worker-app contract (Phase 2, /v1/batches).
 *
 * The worker CREATES the customer in the app, builds the batch scan by scan
 * (ONE scan = ONE physical unit, its AYROVI identity AYP-… comes from the
 * server) and submits when done. The device never invents identity data:
 * the original barcode/SKU travels VERBATIM when readable, and MANUAL adds
 * carry NO invented original. Idempotency keys are generated per operation
 * on this device — a retried add returns the SAME unit.
 */

@Serializable
data class BatchCustomerIn(
    val name: String,
    val externalRef: String? = null,
)

@Serializable
data class BatchUnitIn(
    val idempotencyKey: String,
    val identifierType: String,
    val identifierValue: String? = null,
    val originalBarcode: String? = null,
    val originalSku: String? = null,
    val originalReference: String? = null,
)

@Serializable
data class BatchCreateIn(
    val idempotencyKey: String,
    val customer: BatchCustomerIn,
    val firstItem: BatchUnitIn? = null,
)

@Serializable
data class BatchSubmitIn(
    val idempotencyKey: String,
    val note: String? = null,
)

@Serializable
data class BatchCustomerPayload(
    val id: String = "",
    val name: String = "",
    val externalRef: String? = null,
    val needsReview: Boolean = true,
)

@Serializable
data class BatchRowPayload(
    val id: String = "",
    val batchCode: String = "",
    val status: String = "",
    val totalExpected: Int = 0,
    val totalScanned: Int = 0,
    val createdAt: String? = null,
    val customer: BatchCustomerPayload? = null,
)

@Serializable
data class BatchUnitPayload(
    val id: String = "",
    val code: String = "",
    val originalBarcode: String? = null,
    val originalSku: String? = null,
    val originalReference: String? = null,
)

@Serializable
data class BatchItemPayload(
    val id: String = "",
    val status: String = "REGISTERED",
    val identifierType: String = "",
    val identifierValue: String? = null,
    val unit: BatchUnitPayload = BatchUnitPayload(),
)

@Serializable
data class BatchDetailPayload(
    val id: String = "",
    val batchCode: String = "",
    val status: String = "",
    val totalExpected: Int = 0,
    val totalScanned: Int = 0,
    val createdAt: String? = null,
    val customer: BatchCustomerPayload? = null,
    val items: List<BatchItemPayload> = emptyList(),
)

@Serializable
data class BatchCreatedPayload(
    val batch: BatchRowPayload = BatchRowPayload(),
    val customer: BatchCustomerPayload? = null,
    val first: BatchUnitAddedPayload? = null,
    val replayed: Boolean = false,
)

@Serializable
data class BatchUnitAddedPayload(
    val unit: BatchUnitPayload = BatchUnitPayload(),
    val item: BatchItemPayload = BatchItemPayload(),
    val replayed: Boolean = false,
)

@Serializable
data class BatchSubmittedPayload(
    val batch: BatchRowPayload = BatchRowPayload(),
    val replayed: Boolean = false,
)

/**
 * Gateway contract — implemented by WorkerRepository (same rule as
 * ReceivingGateway/TemporaryStorageGateway: no UI/network dependency here).
 */
interface BatchGateway {
    /** CREATE the batch (+ optional first scan) — server generates the AYB code. */
    suspend fun batchCreate(input: BatchCreateIn): BatchCreatedPayload

    /** Add ONE physical unit — server generates its AYP identity. */
    suspend fun batchAddUnit(batchId: String, input: BatchUnitIn): BatchUnitAddedPayload

    /** Submit the finished build — CREATED -> SUBMITTED. */
    suspend fun batchSubmit(batchId: String, input: BatchSubmitIn): BatchSubmittedPayload

    /** Resumable builds (status=CREATED) for this worker to pick up again. */
    suspend fun batchOpen(): List<BatchRowPayload>

    /** Full batch (items + units) for resuming a build on this device. */
    suspend fun batchDetail(batchId: String): BatchDetailPayload
}
