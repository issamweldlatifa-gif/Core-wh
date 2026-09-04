package com.ayrovi.worker.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Wire DTOs. Decoding is tolerant (ignoreUnknownKeys + defaulted nulls) so a
 * server that adds fields never breaks an older installed worker app — the
 * backend stays the single source of truth for what a worker may do.
 */

@Serializable
data class LoginRequest(
    val identifier: String,
    val secret: String,
    val mode: String? = null, // 'pin' | 'password' (lowercase, matches backend LoginDto)
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
    val expectedArrival: ExpectedArrivalRef? = null,
)

@Serializable
data class TerminalContext(
    val worker: WorkerRef? = null,
    val tasks: List<TerminalTask> = emptyList(),
    val readyTaskCount: Int? = null,
    val home: String? = null,
    val station: StationRef? = null,
    val activeSession: ActiveReceivingRef? = null,
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

@Serializable
data class SessionHeader(
    val id: String? = null,
    val code: String? = null,
    val status: String? = null,
    val flash: FlashView? = null,
)

@Serializable
data class FlashView(
    val kind: String? = null,
    val code: String? = null,
    val message: String? = null,
    val shipment: String? = null,
    val sku: String? = null,
    // For CARTON_IDENTIFIED the server puts a carton OBJECT under `carton`;
    // for other kinds it may be a plain string. We only need `kind` — the
    // receive step is driven by the original scanned code.
    val carton: JsonElement? = null,
)

/** Human summary for one scan outcome shown to the operator. */
data class ScanFlashUi(
    val ok: Boolean,
    val title: String,
    val detail: String? = null,
)
