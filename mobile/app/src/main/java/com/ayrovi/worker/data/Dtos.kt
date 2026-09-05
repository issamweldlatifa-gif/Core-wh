package com.ayrovi.worker.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable data class LoginRequest(
    val identifier: String, val secret: String, val mode: String? = null,
    val app: String = "WORKER_NATIVE", val deviceId: String? = null,
)
@Serializable data class AuthTokens(val accessToken: String, val refreshToken: String)
@Serializable data class MeUser(
    val id: String? = null, val name: String? = null, val employeeCode: String? = null,
    val email: String? = null, val status: String? = null,
)
@Serializable data class MeSession(
    val id: String? = null, val application: String? = null, val deviceId: String? = null, val stationId: String? = null,
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
)
@Serializable data class TerminalContext(
    val worker: WorkerRef? = null, val tasks: List<TerminalTask> = emptyList(),
    val readyTaskCount: Int? = null, val home: String? = null,
    val station: StationRef? = null, val activeSession: ActiveReceivingRef? = null,
    val resume: ResumeRef? = null,
)
@Serializable data class TerminalAssignment(
    val id: String, val title: String, val description: String? = null,
    val relatedCode: String? = null, val status: String? = null,
)
@Serializable data class AssignmentsResponse(
    val open: List<TerminalAssignment> = emptyList(), val recent: List<TerminalAssignment> = emptyList(),
)
@Serializable data class ArrivalRow(
    val id: String? = null, val code: String? = null, val customerName: String? = null,
    val storeName: String? = null, val status: String? = null, val products: Int? = null,
    val units: Int? = null, val shipments: Int? = null, val carrier: String? = null,
    val tracking: String? = null, val cartons: Int? = null,
)

// ---------------- RECEIVING ----------------
@Serializable data class DetailArrival(
    val id: String? = null, val code: String? = null, val externalArrivalId: String? = null,
    val customerName: String? = null, val customerId: String? = null,
    val storeName: String? = null, val status: String? = null,
)
@Serializable data class CartonRow(
    val id: String? = null, val externalCartonId: String? = null, val reference: String? = null,
    val qrCodeValue: String? = null, val barcodeValue: String? = null,
    val cartonNumber: Int? = null, val totalCartons: Int? = null, val status: String? = null,
    val weight: Double? = null, val weightUnit: String? = null,
)
@Serializable data class CartonEvent(
    val id: String? = null, val code: String? = null, val scanType: String? = null, val source: String? = null,
    val status: String? = null, val cartonId: String? = null, val receivedAt: String? = null,
)
@Serializable data class ProductRow(
    val id: String? = null, val sku: String? = null, val reference: String? = null,
    val productName: String? = null, val category: String? = null, val subcategory: String? = null,
    val categoryStatus: String? = null, val expected: Int = 0, val received: Int = 0,
    val remaining: Int = 0, val difference: Int = 0, val status: String? = null,
)
@Serializable data class DiscrepancyRow(
    val id: String? = null, val type: String? = null, val status: String? = null, val reason: String? = null,
    val expected: Int? = null, val actual: Int? = null, val difference: Int? = null, val sku: String? = null,
    val cartonCode: String? = null, val resolution: String? = null,
)
@Serializable data class ReceivingTally(
    val expectedCartons: Int = 0, val receivedCartons: Int = 0,
    val expectedProducts: Int = 0, val receivedProducts: Int = 0,
    val expectedUnits: Int = 0, val receivedUnits: Int = 0,
    val openDiscrepancies: Int = 0, val shortUnits: Int = 0,
    val overageUnits: Int = 0, val unexpectedProducts: Int = 0, val missingCartons: Int = 0,
)
@Serializable data class FlashView(
    val kind: String? = null, val code: String? = null, val message: String? = null,
    val shipment: JsonElement? = null, val arrival: JsonElement? = null,
    val sku: String? = null, val expected: Int? = null, val received: Int? = null,
    val carton: JsonElement? = null, val article: JsonElement? = null,
    val container: String? = null, val location: String? = null,
    val bin: String? = null, val customer: String? = null,
)
@Serializable data class ReceivingSession(
    val id: String, val code: String, val status: String, val startedAt: String,
    val pausedAt: String? = null, val completedAt: String? = null,
    val deviceType: String? = null, val deviceName: String? = null, val scanSource: String? = null,
    val arrival: DetailArrival = DetailArrival(),
    val cartons: List<CartonRow> = emptyList(),
    val receivedCartonEvents: List<CartonEvent> = emptyList(),
    val products: List<ProductRow> = emptyList(),
    val discrepancies: List<DiscrepancyRow> = emptyList(),
    val tally: ReceivingTally = ReceivingTally(),
    val flash: FlashView? = null,
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

@Serializable data class ArticleScanResult(
    val flash: FlashView? = null, val matched: Boolean = false, val receivingProductId: String? = null,
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
