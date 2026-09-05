package com.ayrovi.worker.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Wire DTOs. Decoding is intentionally tolerant (the repository Json instance
 * uses ignoreUnknownKeys) while these shapes mirror the worker API responses.
 */

@Serializable
data class LoginRequest(
    val identifier: String,
    val secret: String,
    val mode: String? = null,
    val app: String = "WORKER_NATIVE",
    val deviceId: String? = null,
)

@Serializable
data class AuthTokens(
    val accessToken: String,
    val refreshToken: String,
)

@Serializable
data class MeUser(
    val id: String? = null,
    val name: String? = null,
    val employeeCode: String? = null,
    val email: String? = null,
    val status: String? = null,
)

@Serializable
data class MeSession(
    val id: String? = null,
    val application: String? = null,
    val deviceId: String? = null,
    val stationId: String? = null,
)

@Serializable
data class MeResponse(
    val user: MeUser? = null,
    val roles: List<String> = emptyList(),
    val permissions: List<String> = emptyList(),
    val application: String? = null,
    val allowedApplications: List<String> = emptyList(),
    val session: MeSession? = null,
)

@Serializable
data class WorkerRef(val id: String? = null)

@Serializable
data class TerminalTask(
    val key: String? = null,
    val label: String? = null,
    val path: String? = null,
    val description: String? = null,
    val ready: Boolean? = null,
)

@Serializable
data class StationRef(
    val id: String? = null,
    val code: String? = null,
    val name: String? = null,
    val department: String? = null,
    val capabilities: List<String> = emptyList(),
)

@Serializable
data class ExpectedArrivalRef(
    val id: String? = null,
    val code: String? = null,
    val customerName: String? = null,
)

@Serializable
data class ActiveReceivingRef(
    val id: String? = null,
    val code: String? = null,
    val status: String? = null,
    val startedAt: String? = null,
    val expectedArrival: ExpectedArrivalRef? = null,
)

@Serializable
data class ActivePutawayRef(
    val id: String? = null,
    val code: String? = null,
    val status: String? = null,
    val startedAt: String? = null,
)

@Serializable
data class TerminalContext(
    val worker: WorkerRef? = null,
    val tasks: List<TerminalTask> = emptyList(),
    val readyTaskCount: Int? = null,
    val home: String? = null,
    val station: StationRef? = null,
    val activeSession: ActiveReceivingRef? = null,
    val activePutaway: ActivePutawayRef? = null,
)

@Serializable
data class ArrivalRow(
    val id: String? = null,
    val code: String? = null,
    val customerName: String? = null,
    val storeName: String? = null,
    val status: String? = null,
    val products: Int? = null,
    val units: Int? = null,
    val shipments: Int? = null,
    val carrier: String? = null,
    val tracking: String? = null,
    val cartons: Int? = null,
)

// ---------------------------------------------------------------------------
// Receiving — exact projection returned by ReceivingService.sessionDetail().
// ---------------------------------------------------------------------------

@Serializable
data class DetailArrival(
    val id: String? = null,
    val code: String? = null,
    val externalArrivalId: String? = null,
    val customerName: String? = null,
    val customerId: String? = null,
    val storeName: String? = null,
    val status: String? = null,
)

@Serializable
data class CartonRow(
    val id: String? = null,
    val externalCartonId: String? = null,
    val reference: String? = null,
    val qrCodeValue: String? = null,
    val barcodeValue: String? = null,
    val cartonNumber: Int? = null,
    val totalCartons: Int? = null,
    val status: String? = null,
    val weight: Double? = null,
    val weightUnit: String? = null,
)

@Serializable
data class CartonEvent(
    val id: String? = null,
    val code: String? = null,
    val scanType: String? = null,
    val source: String? = null,
    val status: String? = null,
    val cartonId: String? = null,
    val receivedAt: String? = null,
)

@Serializable
data class ProductRow(
    val id: String? = null,
    val sku: String? = null,
    val reference: String? = null,
    val productName: String? = null,
    val category: String? = null,
    val subcategory: String? = null,
    val categoryStatus: String? = null,
    val expected: Int = 0,
    val received: Int = 0,
    val remaining: Int = 0,
    val difference: Int = 0,
    val status: String? = null,
)

@Serializable
data class DiscrepancyRow(
    val id: String? = null,
    val type: String? = null,
    val status: String? = null,
    val reason: String? = null,
    val expected: Int? = null,
    val actual: Int? = null,
    val difference: Int? = null,
    val resolution: String? = null,
)

@Serializable
data class ReceivingTally(
    val expectedCartons: Int = 0,
    val receivedCartons: Int = 0,
    val expectedProducts: Int = 0,
    val receivedProducts: Int = 0,
    val expectedUnits: Int = 0,
    val receivedUnits: Int = 0,
    val openDiscrepancies: Int = 0,
    val shortUnits: Int = 0,
    val overageUnits: Int = 0,
    val unexpectedProducts: Int = 0,
    val missingCartons: Int = 0,
)

@Serializable
data class FlashView(
    val kind: String? = null,
    val code: String? = null,
    val message: String? = null,
    val shipment: JsonElement? = null,
    val arrival: JsonElement? = null,
    val sku: String? = null,
    val expected: Int? = null,
    val received: Int? = null,
    val carton: JsonElement? = null,
)

@Serializable
data class ReceivingSession(
    val id: String,
    val code: String,
    val status: String,
    val startedAt: String,
    val pausedAt: String? = null,
    val completedAt: String? = null,
    val deviceType: String? = null,
    val deviceName: String? = null,
    val scanSource: String? = null,
    val arrival: DetailArrival = DetailArrival(),
    val cartons: List<CartonRow> = emptyList(),
    val receivedCartonEvents: List<CartonEvent> = emptyList(),
    val products: List<ProductRow> = emptyList(),
    val discrepancies: List<DiscrepancyRow> = emptyList(),
    val tally: ReceivingTally = ReceivingTally(),
    val flash: FlashView? = null,
)

// ---------------------------------------------------------------------------
// Putaway — projections returned by PutawayService.
// ---------------------------------------------------------------------------

@Serializable
data class PutawayQueueCarton(
    val id: String? = null,
    val externalCartonId: String? = null,
    val cartonNumber: Int? = null,
    val totalCartons: Int? = null,
    val receivedAt: String? = null,
    val shipmentCode: String? = null,
    val arrivalCode: String? = null,
    val customerName: String? = null,
)

@Serializable
data class PutawayWorker(
    val id: String? = null,
    val name: String? = null,
    val employeeCode: String? = null,
)

@Serializable
data class PutawayStation(
    val id: String? = null,
    val code: String? = null,
    val name: String? = null,
)

@Serializable
data class PutawayPlacement(
    val id: String? = null,
    val cartonCode: String? = null,
    val locationCode: String? = null,
    val placedAt: String? = null,
    val releasedAt: String? = null,
    val cartonSource: String? = null,
    val locationSource: String? = null,
)

@Serializable
data class PutawayTally(
    val storedThisSession: Int = 0,
    val totalPlacements: Int = 0,
    val pendingCartons: Int = 0,
)

@Serializable
data class PutawaySession(
    val id: String,
    val code: String,
    val status: String,
    val startedAt: String,
    val completedAt: String? = null,
    val worker: PutawayWorker? = null,
    val station: PutawayStation? = null,
    val placements: List<PutawayPlacement> = emptyList(),
    val tally: PutawayTally = PutawayTally(),
)

@Serializable
data class PutawayFlashView(
    val kind: String? = null,
    val code: String? = null,
    val status: String? = null,
    val carton: JsonElement? = null,
    val location: JsonElement? = null,
    val moved: Boolean? = null,
)

@Serializable
data class PutawayFlashEnvelope(val flash: PutawayFlashView)

@Serializable
data class PutawayPlaceResponse(
    val flash: PutawayFlashView,
    val session: PutawaySession? = null,
)

/** Human summary for one scan outcome shown to the operator. */
data class ScanFlashUi(
    val ok: Boolean,
    val title: String,
    val detail: String? = null,
)
