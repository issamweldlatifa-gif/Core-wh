package com.ayrovi.worker.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable data class LoginRequest(
    val identifier: String, val secret: String, val mode: String? = null,
    val app: String = "WORKER_NATIVE", val deviceId: String? = null,
) {
    override fun toString() = "LoginRequest(REDACTED)"
}
@Serializable data class AuthTokens(val accessToken: String, val refreshToken: String) {
    override fun toString() = "AuthTokens(REDACTED)"
}
@Serializable data class MeUser(
    val id: String? = null, val name: String? = null, val employeeCode: String? = null,
    val email: String? = null, val status: String? = null,
)
@Serializable data class MeSession(
    val id: String? = null, val application: String? = null, val deviceId: String? = null, val stationId: String? = null,
    val expiresAt: String? = null,
)
@Serializable data class MeResponse(
    val user: MeUser? = null, val roles: List<String> = emptyList(),
    val permissions: List<String> = emptyList(), val application: String? = null,
    val allowedApplications: List<String> = emptyList(), val session: MeSession? = null,
)
@Serializable data class WorkerRef(val id: String? = null)
@Serializable data class TerminalTask(
    val key: String? = null, val label: String? = null, val path: String? = null,
    val description: String? = null, val department: String? = null, val ready: Boolean? = null,
    val permission: String? = null,
)
@Serializable data class StationRef(
    val id: String? = null, val code: String? = null, val name: String? = null,
    val department: String? = null, val capabilities: List<String> = emptyList(),
)
@Serializable data class ExpectedArrivalRef(
    val id: String? = null, val code: String? = null, val customerName: String? = null, val storeName: String? = null,
)
@Serializable data class ActiveReceivingRef(
    val id: String? = null, val code: String? = null, val status: String? = null,
    val startedAt: String? = null, val expectedArrival: ExpectedArrivalRef? = null,
)
@Serializable data class ResumeRef(
    val path: String? = null, val label: String? = null, val code: String? = null,
    val kind: String? = null, val startedAt: String? = null,
)
@Serializable data class TerminalContext(
    val worker: WorkerRef? = null, val tasks: List<TerminalTask> = emptyList(),
    val readyTaskCount: Int? = null, val home: String? = null,
    val station: StationRef? = null, val activeSession: ActiveReceivingRef? = null,
    val resume: ResumeRef? = null,
    val activePutaway: ActiveReceivingRef? = null,
)
@Serializable data class TerminalAssignment(
    val id: String, val title: String, val description: String? = null,
    val relatedCode: String? = null, val status: String? = null,
    val taskKey: String? = null, val entity: AssignmentEntities? = null,
) {
    val isInstruction: Boolean get() = taskKey.isNullOrBlank() && entity?.let {
        it.arrival == null && it.carton == null && it.container == null && it.outbound == null && it.order == null
    } != false
}
@Serializable data class AssignmentEntity(val id: String? = null, val code: String? = null, val status: String? = null)
@Serializable data class AssignmentEntities(val arrival: AssignmentEntity? = null, val carton: AssignmentEntity? = null,
    val container: AssignmentEntity? = null, val outbound: AssignmentEntity? = null, val order: AssignmentEntity? = null)
@Serializable data class WorkCount(val key: String, val assigned: Int = 0, val available: Int = 0, val mine: Int = 0)
@Serializable data class AssignmentsResponse(
    val open: List<TerminalAssignment> = emptyList(), val recent: List<TerminalAssignment> = emptyList(),
)
@Serializable data class ArrivalRow(
    val id: String? = null, val code: String? = null, val customerName: String? = null,
    val storeName: String? = null, val status: String? = null, val products: Int? = null,
    val units: Int? = null, val shipments: Int? = null, val carrier: String? = null,
    val tracking: String? = null, val cartons: Int? = null,
)

// ---------------- RECEIVING (card-based, device-side matching) ----------------
// The CRM pushes two INDEPENDENT card types: PRODUCT CARDS (Customer Arrival
// Card) and CARTON CARDS (Shipment Card). They are downloaded with the session
// and matched on the device; they are never merged or modified here.
@Serializable data class DetailArrival(
    val id: String? = null, val code: String? = null, val externalArrivalId: String? = null,
    val customerName: String? = null, val customerId: String? = null,
    val storeName: String? = null, val status: String? = null,
)
@Serializable data class ShipmentRef(
    val id: String? = null, val code: String? = null, val externalShipmentId: String? = null,
    val carrierName: String? = null, val carrierCode: String? = null, val trackingNumber: String? = null,
    val senderName: String? = null, val senderCompany: String? = null, val shippedAt: String? = null,
    val totalCartons: Int? = null, val totalProducts: Int? = null, val totalUnits: Int? = null,
)
/** PRODUCT CARD (Customer Arrival Card line) — expected data for the PRODUIT lane. */
@Serializable data class ProductCard(
    val id: String? = null, val sku: String? = null, val reference: String? = null,
    val productName: String? = null, val category: String? = null, val subcategory: String? = null,
    val categoryStatus: String? = null,
    val expected: Int = 0, val received: Int = 0, val remaining: Int = 0,
    val status: String? = null,
    /** Normalized (uppercased) comparison keys for device-side matching. */
    val identifiers: List<String> = emptyList(),
)
@Serializable data class CartonDimensions(
    val length: Double? = null, val width: Double? = null, val height: Double? = null, val unit: String? = null,
)
/** CARTON CARD (Shipment Card carton) — expected data for the CARTON lane. CARTON FIX: preserve carton identity, suivi, QR, barcode */
@Serializable data class CartonCard(
    val id: String? = null, val externalCartonId: String? = null, val reference: String? = null,
    val qrCodeValue: String? = null, val barcodeValue: String? = null,
    // CARTON FIX fields
    val suiviCode: String? = null,
    val trackingCode: String? = null,
    val entityType: String? = null, // Always CARTON
    val productCount: Int? = null,
    val sourceProject: String? = null,
    val metadata: kotlinx.serialization.json.JsonElement? = null,
    val originalPayload: kotlinx.serialization.json.JsonElement? = null,
    val cartonNumber: Int = 0, val totalCartons: Int = 0,
    /** Shipment-level card data carried by every carton card of the shipment. */
    val trackingNumber: String? = null, val senderName: String? = null, val shippedAt: String? = null,
    val weight: Double? = null, val weightUnit: String? = null, val dimensions: CartonDimensions? = null,
    val status: String? = null,
    val products: List<CartonProduct>? = null,
    /** Normalized (uppercased) comparison keys for device-side matching. */
    val identifiers: List<String> = emptyList(),
)

@Serializable data class CartonProduct(
    val sku: String? = null,
    val reference: String? = null,
    val productName: String? = null,
    val quantity: Int = 0,
)
@Serializable data class DiscrepancyRow(
    val id: String? = null, val type: String? = null, val status: String? = null, val reason: String? = null,
    val expected: Int? = null, val actual: Int? = null, val difference: Int? = null, val sku: String? = null,
    val cartonCode: String? = null, val resolution: String? = null,
)
@Serializable data class ReceivingTally(
    val expectedCartons: Int, val receivedCartons: Int,
    val expectedProducts: Int, val receivedProducts: Int,
    val expectedUnits: Int, val receivedUnits: Int,
    val openDiscrepancies: Int, val shortUnits: Int,
    val overageUnits: Int, val unexpectedProducts: Int, val missingCartons: Int,
)
@Serializable data class FlashView(
    val kind: String? = null, val code: String? = null, val message: String? = null,
    val cardType: String? = null,
    val shipment: JsonElement? = null, val arrival: JsonElement? = null,
    val sku: String? = null, val expected: Int? = null, val received: Int? = null,
    val carton: JsonElement? = null, val cartons: JsonElement? = null, val article: JsonElement? = null,
    val container: String? = null, val location: String? = null,
    val bin: String? = null, val customer: String? = null,
    val containerCount: Int? = null, val containerCapacity: Int? = null, val containerFull: Boolean = false,
)
@Serializable data class ReceivingSession(
    val id: String, val code: String, val status: String, val startedAt: String,
    val pausedAt: String? = null, val completedAt: String? = null,
    val deviceType: String? = null, val deviceName: String? = null, val scanSource: String? = null,
    val arrival: DetailArrival = DetailArrival(),
    val shipment: ShipmentRef? = null,
    val productCards: List<ProductCard> = emptyList(),
    val cartonCards: List<CartonCard> = emptyList(),
    val discrepancies: List<DiscrepancyRow> = emptyList(),
    val tally: ReceivingTally,
    val flash: FlashView? = null,
)

// ---------------- RECEIVING HOME (automatic-dispatch feed) ----------------
// RECEIVING never opens the scanner directly. It opens the HOME feed: the
// PRODUCT and CARTON cards dispatched to this worker, with live counters.
// The card lists are information only — the worker never picks a card;
// scanning matches the physical identifier automatically on the device.
@Serializable data class HomeProductRow(
    val arrivalCode: String? = null, val reference: String? = null,
    val label: String? = null, val remaining: Int = 0,
)
@Serializable data class HomeCartonRow(
    val arrivalCode: String? = null, val reference: String? = null,
    val tracking: String? = null, val remaining: Int = 0,
    val suiviCode: String? = null,
)
@Serializable data class ReceivingHome(
    val productCards: List<ProductCard> = emptyList(),
    val cartonCards: List<CartonCard> = emptyList(),
    val productCardsPending: Int = 0,
    val cartonCardsPending: Int = 0,
    val productList: List<HomeProductRow> = emptyList(),
    val cartonList: List<HomeCartonRow> = emptyList(),
)
/** Response of a HOME scan: the verdict flash plus the refreshed feed. */
@Serializable data class HomeScanResult(
    val ok: Boolean = true,
    val sessionId: String? = null,
    val flash: FlashView? = null,
    val home: ReceivingHome? = null,
)

// ---------------- FULFILLMENT ----------------
@Serializable data class OpContainer(
    val id: String? = null, val code: String, val type: String? = null, val status: String? = null,
    val label: String? = null, val order: OpOrderRef? = null,
    val _count: OpCount? = null,
) {
    val articleCount: Int get() = _count?.articles ?: 0
}
@Serializable data class OpCount(val articles: Int = 0)
@Serializable data class OpOrderRef(
    val externalOrderReference: String? = null,
    val externalCustomerReference: String? = null,
)
@Serializable data class OpOrderItem(
    val sku: String? = null, val productName: String? = null,
    val requested: Int = 0, val inBin: Int = 0,
)
@Serializable data class OpArticle(
    val code: String? = null, val sku: String? = null, val productName: String? = null,
    val category: String? = null, val subcategory: String? = null,
    val categoryStatus: String? = null, val status: String? = null,
)
@Serializable data class OpContainerDetail(
    val id: String? = null, val code: String, val type: String? = null, val status: String? = null,
    val label: String? = null, val order: OpOrderDetail? = null, val articles: List<OpArticle> = emptyList(),
    val capacity: Int? = null,
)
@Serializable data class OpOrderDetail(
    val externalOrderReference: String? = null, val externalCustomerReference: String? = null,
    val items: List<OpOrderLine> = emptyList(),
)
@Serializable data class OpOrderLine(
    val product: OpProduct? = null, val requestedQuantity: Int = 0, val status: String? = null,
)
@Serializable data class OpProduct(
    val externalProductCode: String? = null, val name: String? = null,
)

@Serializable data class ClosedContainer(
    val ok: Boolean? = null, val code: String, val status: String? = null, val count: Int = 0,
)

// Sorting
@Serializable data class SortingZone(val id: String? = null, val code: String? = null, val name: String? = null)
@Serializable data class SortingResult(
    val kind: String, val article: OpArticle? = null,
    val zone: SortingZone? = null, val suggestedLocations: List<String> = emptyList(),
    val reason: String? = null, val action: String? = null,
)
@Serializable data class SortingStoreResult(val flash: FlashView? = null, val article: OpArticle? = null)

// Customer order sorting
@Serializable data class OrderSortingBin(val code: String? = null, val label: String? = null)
@Serializable data class OrderSortingResult(
    val kind: String, val article: OpArticle? = null,
    val order: OrderRef? = null, val orderItemId: String? = null,
    val bin: OrderSortingBin? = null, val binMissing: Boolean = false,
    val reason: String? = null,
)
@Serializable data class OrderRef(val reference: String? = null, val customer: String? = null)
@Serializable data class OrderSortingAssignResult(val flash: FlashView? = null)

// Packing
@Serializable data class PackingView(
    val bin: BinRef, val order: OrderRef,
    val required: List<RequiredItem> = emptyList(),
    val articles: List<OpArticle> = emptyList(), val complete: Boolean = false,
)
@Serializable data class BinRef(val code: String, val label: String? = null, val status: String? = null)
@Serializable data class RequiredItem(
    val sku: String? = null, val productName: String? = null,
    val requested: Int = 0, val inBin: Int = 0,
)
@Serializable data class PackResultShipment(
    val code: String, val status: String? = null,
    val carrier: String? = null, val trackingNumber: String? = null, val labelValue: String? = null,
)
@Serializable data class PackResult(val flash: FlashView? = null, val shipment: PackResultShipment? = null)

// Shipping
@Serializable data class ShipmentView(
    val id: String? = null, val code: String, val status: String? = null,
    val carrier: String? = null, val trackingNumber: String? = null,
    val order: OpOrderRef? = null, val articles: List<OpArticle> = emptyList(),
    val container: BinRef? = null, val shippedAt: String? = null,
)
@Serializable data class ShipResult(val flash: FlashView? = null)

// Trace
@Serializable data class TraceView(
    val article: OpArticle? = null, val trace: TraceChain? = null,
)
@Serializable data class TraceChain(
    val crmCard: String? = null, val expectedArrival: String? = null,
    val inboundShipment: String? = null, val sourceCarton: String? = null,
    val receivingSession: String? = null,
    val container: TraceContainer? = null,
    val storageLocation: TraceLocation? = null,
    val customerOrder: String? = null, val customer: String? = null,
    val outboundShipment: String? = null, val tracking: String? = null, val shippedAt: String? = null,
)
@Serializable data class TraceContainer(val code: String? = null, val type: String? = null, val label: String? = null)
@Serializable data class TraceLocation(val code: String? = null, val zone: String? = null)

// ---------------- TEMPORARY STORAGE (product flow station) ----------------
// Mirrors GET/POST /v1/temporary-storage/* (WORKER_NATIVE). camelCase JSON.
@Serializable data class TsStationRef(
    val id: String? = null, val code: String? = null, val name: String? = null,
    val department: String? = null,
)
@Serializable data class TsHeader(
    val activeProducts: Int? = null, val containers: Int? = null,
    val completed: Int? = null, val remaining: Int? = null, val review: Int? = null,
)
@Serializable data class TsCustomerSummary(
    val customer: String? = null, val received: Int? = null, val remaining: Int? = null,
)
@Serializable data class TsSectionSummary(
    val letter: String? = null, val products: Int? = null, val stored: Int? = null,
    val customers: List<TsCustomerSummary> = emptyList(),
)
@Serializable data class TsHomePayload(
    val station: TsStationRef? = null, val header: TsHeader? = null,
    val currentSection: String? = null, val sections: List<TsSectionSummary> = emptyList(),
)
@Serializable data class TsContainerCard(
    val code: String? = null, val current: Int? = null, val capacity: Int? = null,
    val status: String? = null, val active: Boolean? = null,
)
@Serializable data class TsCustomerGroup(
    val customer: String? = null, val surname: String? = null,
    val received: Int? = null, val stored: Int? = null, val remaining: Int? = null,
    val containers: List<TsContainerCard> = emptyList(), val hasReview: Boolean? = null,
)
@Serializable data class TsReviewRow(
    val id: String? = null, val sku: String? = null, val reference: String? = null,
    val productName: String? = null, val customerName: String? = null,
    val reason: String? = null, val scannedAt: String? = null, val scannedBy: String? = null,
)
@Serializable data class TsSectionPayload(
    val station: TsStationRef? = null, val letter: String? = null,
    val reviewItems: List<TsReviewRow> = emptyList(),
    val customers: List<TsCustomerGroup> = emptyList(),
)
@Serializable data class TsTargetContainer(
    val code: String? = null, val current: Int? = null, val capacity: Int? = null,
    val status: String? = null, val mustCreate: Boolean? = null,
)
@Serializable data class TsScanProductRef(
    val sku: String? = null, val reference: String? = null, val productName: String? = null,
    val customer: String? = null, val surname: String? = null, val section: String? = null,
)
@Serializable data class TsScanPayload(
    val status: String? = null, val message: String? = null,
    val product: TsScanProductRef? = null, val remaining: Int? = null,
    val targetContainer: TsTargetContainer? = null,
)
@Serializable data class TsPlacedContainer(
    val code: String? = null, val current: Int? = null, val capacity: Int? = null,
    val status: String? = null,
)
@Serializable data class TsExpectedContainer(
    val section: String? = null, val containerCode: String? = null,
)
@Serializable data class TsPlacePayload(
    val status: String? = null, val message: String? = null, val itemId: String? = null,
    val container: TsPlacedContainer? = null, val remaining: Int? = null,
    val nextTarget: TsTargetContainer? = null, val expected: TsExpectedContainer? = null,
)
@Serializable data class TsReviewRef(
    val itemId: String? = null, val exceptionCode: String? = null, val reason: String? = null,
)
@Serializable data class TsReviewPayload(
    val status: String? = null, val review: TsReviewRef? = null,
    val notifiedAdmins: Int? = null,
)
@Serializable data class TsReportPayload(
    val id: String? = null, val status: String? = null, val stationCode: String? = null,
    val notifiedAdmins: Int? = null, val message: String? = null,
)
