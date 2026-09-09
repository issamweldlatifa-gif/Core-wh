package com.ayrovi.worker.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json

/** Single native API repository, extracted in place from :app. No UI or Android dependency. */
class WorkerRepository(
    private val store: SessionStorage,
    val transport: WorkerTransport,
) : ReceivingGateway {
    constructor(store: SessionStorage, baseUrl: String) : this(store, HttpWorkerTransport.production(baseUrl, store))

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    val connection: StateFlow<ConnectionState> get() = transport.connection

    class ApiException(
        val code: Int,
        override val message: String,
        val outcomeUnknown: Boolean = false,
    ) : Exception(message)

    suspend fun login(identifier: String, secret: String, mode: String?, deviceCode: String): AuthTokens {
        val before = store.snapshot()
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(
            identifier = identifier.trim(), secret = secret, mode = mode,
            app = "WORKER_NATIVE", deviceId = deviceCode,
        ))
        val raw = post("/v1/auth/login", body, auth = false)
        val tokens = json.decodeFromString(AuthTokens.serializer(), raw)
        if (tokens.accessToken.isBlank() || tokens.refreshToken.isBlank()) throw ContractFailure("Invalid sign-in response.")
        if (!store.replace(before.version, tokens, newLogin = true)) throw ApiException(401, "Sign-in was cancelled. Try again.")
        store.employeeCode = identifier.trim()
        return tokens
    }

    suspend fun me(): MeResponse = json.decodeFromString(MeResponse.serializer(), get("/v1/auth/me"))
    suspend fun terminalContext(): TerminalContext = json.decodeFromString(TerminalContext.serializer(), get("/v1/terminal/context"))
    suspend fun workCounts(): List<WorkCount> = json.decodeFromString(
        kotlinx.serialization.builtins.ListSerializer(WorkCount.serializer()), get("/v1/terminal/work"))
    suspend fun closeContainer(code: String): ClosedContainer = json.decodeFromString(ClosedContainer.serializer(),
        post("/v1/fulfillment/containers/${urlEncode(code)}/close", "{}"))

    suspend fun assignments(): AssignmentsResponse = json.decodeFromString(AssignmentsResponse.serializer(), get("/v1/terminal/assignments"))
    suspend fun completeAssignment(id: String) { post("/v1/terminal/assignments/${urlEncode(id)}/complete", "{}") }

    /**
     * Worker support report — the EXISTING backend "Report a Problem" action
     * (POST /v1/fulfillment/exceptions → OperationalException row, visible on
     * the Admin exceptions board, audited). No duplicate reporting API:
     * Settings → Send Report / Report a Problem both submit here.
     * @param stage operational stage/context (e.g. RECEIVING / SETTINGS)
     * @param type report category (uses backend free-form type; ops-relevant)
     * @param reason the worker's description
     * @param entityCode optional reference/card/task code the report concerns
     */
    suspend fun reportProblem(stage: String, type: String, reason: String, entityCode: String? = null) {
        val body = buildString {
            append("{\"stage\":").append(jq(stage))
            append(",\"type\":").append(jq(type))
            append(",\"reason\":").append(jq(reason))
            if (!entityCode.isNullOrBlank()) append(",\"entityCode\":").append(jq(entityCode))
            append("}")
        }
        post("/v1/fulfillment/exceptions", body)
    }

    override suspend fun receivingSession(sessionId: String): ReceivingSession = json.decodeFromString(
        ReceivingSession.serializer(), get("/v1/receiving/sessions/${urlEncode(sessionId)}"),
    )

    override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession {
        val fields = mutableListOf("\"reason\":${jq(reason)}")
        if (sku != null) fields.add("\"sku\":${jq(sku)}")
        if (code != null) fields.add("\"code\":${jq(code)}")
        return json.decodeFromString(ReceivingSession.serializer(),
            post("/v1/receiving/sessions/${urlEncode(sessionId)}/flag", "{${fields.joinToString(",")}}"))
    }

    override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession =
        json.decodeFromString(ReceivingSession.serializer(), post(
            "/v1/receiving/discrepancies/${urlEncode(discrepancyId)}/resolve",
            """{"resolution":${jq(resolution)}}""",
        ))

    // ---------------- RECEIVING HOME (automatic-dispatch feed) ----------------
    override suspend fun receivingHome(): ReceivingHome =
        json.decodeFromString(ReceivingHome.serializer(), get("/v1/receiving/home"))

    override suspend fun homeConfirmProduct(
        identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        val body = buildString {
            append("{\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"quantity\":").append(quantity)
            append(",\"operationId\":").append(jq(operationId))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        return json.decodeFromString(HomeScanResult.serializer(), post("/v1/receiving/home/product", body))
    }

    override suspend fun homeConfirmCarton(
        identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String?,
    ): HomeScanResult {
        val body = buildString {
            append("{\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"operationId\":").append(jq(operationId))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        return json.decodeFromString(HomeScanResult.serializer(), post("/v1/receiving/home/carton", body))
    }

    override suspend fun registerPushToken(token: String, platform: String, deviceId: String?) {
        val body = buildString {
            append("{\"token\":").append(jq(token))
            append(",\"platform\":").append(jq(platform))
            if (deviceId != null) append(",\"deviceId\":").append(jq(deviceId))
            append("}")
        }
        post("/v1/notifications/push-token", body)
    }

    override suspend fun unregisterPushToken(token: String) {
        transport.request("DELETE", "/v1/notifications/push-token", "{\"token\":${jq(token)}}", authenticated = true)
    }

    override suspend fun homeMismatch(
        cardType: String, identifier: String,
        identifierType: String, source: String, startedAt: String?,
    ): HomeScanResult {
        val body = buildString {
            append("{\"cardType\":").append(jq(cardType))
            append(",\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        return json.decodeFromString(HomeScanResult.serializer(), post("/v1/receiving/home/mismatch", body))
    }

    // ---------------- RECEIVING (one existing backend contract) ----------------
    override suspend fun arrivals(): List<ArrivalRow> =
        json.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(ArrivalRow.serializer()),
            get("/v1/receiving/arrivals"),
        )

    override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? {
        val raw = get("/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/active")
        if (raw.isBlank() || raw == "null") return null
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession {
        val raw = post(
            "/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/start",
            """{"deviceType":"ANDROID_TERMINAL","deviceName":${jq(store.deviceCode)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    override suspend fun confirmProduct(
        sessionId: String, identifier: String, identifierType: String, quantity: Int,
        operationId: String, source: String, startedAt: String?,
    ): ReceivingSession {
        val body = buildString {
            append("{\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"quantity\":").append(quantity)
            append(",\"operationId\":").append(jq(operationId))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        val raw = post("/v1/receiving/sessions/${urlEncode(sessionId)}/confirm-product", body)
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    override suspend fun confirmCarton(
        sessionId: String, identifier: String, identifierType: String,
        operationId: String, source: String, startedAt: String?,
    ): ReceivingSession {
        val body = buildString {
            append("{\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"operationId\":").append(jq(operationId))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        val raw = post("/v1/receiving/sessions/${urlEncode(sessionId)}/confirm-carton", body)
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    override suspend fun reportMismatch(
        sessionId: String, cardType: String, identifier: String,
        identifierType: String, source: String, startedAt: String?,
    ): ReceivingSession {
        val body = buildString {
            append("{\"cardType\":").append(jq(cardType))
            append(",\"identifier\":").append(jq(identifier))
            append(",\"identifierType\":").append(jq(identifierType))
            append(",\"source\":").append(jq(source))
            if (startedAt != null) append(",\"startedAt\":").append(jq(startedAt))
            append("}")
        }
        val raw = post("/v1/receiving/sessions/${urlEncode(sessionId)}/mismatch", body)
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    override suspend fun pauseSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "pause")
    override suspend fun resumeSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "resume")
    override suspend fun completeSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "complete")

    private suspend fun receivingCommand(sessionId: String, command: String): ReceivingSession =
        json.decodeFromString(
            ReceivingSession.serializer(),
            post("/v1/receiving/sessions/${urlEncode(sessionId)}/$command", "{}"),
        )

    // ---------------- CONFIRMATION REPORT (ORDER 01 verification report) ----------------
    override suspend fun report(sessionId: String): ReceivingReportView = json.decodeFromString(
        ReceivingReportView.serializer(), get("/v1/receiving/sessions/${urlEncode(sessionId)}/report"),
    )

    override suspend fun saveReportDraft(
        sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
    ): ReceivingReportView = json.decodeFromString(
        ReceivingReportView.serializer(),
        put("/v1/receiving/sessions/${urlEncode(sessionId)}/report", draftBody(description, observation, photos)),
    )

    override suspend fun markDamage(sessionId: String, lineId: String, quantity: Int, note: String?): DamageResultView {
        val body = "{\"quantity\":$quantity,\"note\":${if (note.isNullOrBlank()) "null" else jq(note)}}"
        return json.decodeFromString(
            DamageResultView.serializer(),
            post("/v1/receiving/sessions/${urlEncode(sessionId)}/lines/${urlEncode(lineId)}/damage", body),
        )
    }

    override suspend fun submitReport(
        sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
    ): ReceivingReportView = json.decodeFromString(
        ReceivingReportView.serializer(),
        post("/v1/receiving/sessions/${urlEncode(sessionId)}/report/submit", draftBody(description, observation, photos)),
    )

    private fun draftBody(description: String?, observation: String?, photos: List<ReportPhotoInput>): String = buildString {
        append("{\"description\":")
        if (description.isNullOrBlank()) append("null") else append(jq(description))
        append(",\"observation\":")
        if (observation.isNullOrBlank()) append("null") else append(jq(observation))
        append(",\"photos\":[")
        photos.forEachIndexed { i, photo ->
            if (i > 0) append(",")
            append("{\"dataUrl\":").append(jq(photo.dataUrl))
            append(",\"caption\":").append(if (photo.caption.isNullOrBlank()) "null" else jq(photo.caption))
            append(",\"lineId\":").append(if (photo.lineId.isNullOrBlank()) "null" else jq(photo.lineId))
            append("}")
        }
        append("]}")
    }

    // ---------------- FULFILLMENT / OPERATIONAL FLOW ----------------
    // Containers (receiving totes + customer bins)
    suspend fun containers(type: String? = null, status: String? = null): List<OpContainer> {
        val q = buildList {
            if (type != null) add("type=$type"); if (status != null) add("status=$status")
        }.joinToString("&").let { if (it.isNotEmpty()) "?$it" else "" }
        return json.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(OpContainer.serializer()),
            get("/v1/fulfillment/containers$q"),
        )
    }

    suspend fun container(code: String): OpContainerDetail =
        json.decodeFromString(OpContainerDetail.serializer(), get("/v1/fulfillment/containers/${urlEncode(code)}"))

    suspend fun createContainer(type: String, orderReference: String? = null, label: String? = null): OpContainer {
        val parts = mutableListOf(""""type":${jq(type)}""")
        if (orderReference != null) parts.add(""""orderReference":${jq(orderReference)}""")
        if (label != null) parts.add(""""label":${jq(label)}""")
        return json.decodeFromString(OpContainer.serializer(), post("/v1/fulfillment/containers", "{${parts.joinToString(",")}}"))
    }

    // Sorting (stowing)
    suspend fun sortingScan(articleCode: String): SortingResult =
        json.decodeFromString(SortingResult.serializer(), get("/v1/fulfillment/sorting/articles/${urlEncode(articleCode)}"))

    suspend fun sortingStore(articleCode: String, locationCode: String): SortingStoreResult {
        val body = """{"articleCode":${jq(articleCode)},"locationCode":${jq(locationCode)}}"""
        return json.decodeFromString(SortingStoreResult.serializer(), post("/v1/fulfillment/sorting/store", body))
    }

    // Customer order sorting
    suspend fun orderSortingScan(articleCode: String): OrderSortingResult =
        json.decodeFromString(OrderSortingResult.serializer(), get("/v1/fulfillment/order-sorting/articles/${urlEncode(articleCode)}"))

    suspend fun orderSortingAssign(articleCode: String, containerCode: String): OrderSortingAssignResult {
        val body = """{"articleCode":${jq(articleCode)},"containerCode":${jq(containerCode)}}"""
        return json.decodeFromString(OrderSortingAssignResult.serializer(), post("/v1/fulfillment/order-sorting/assign", body))
    }

    // Packing
    suspend fun packingScan(containerCode: String): PackingView =
        json.decodeFromString(PackingView.serializer(), get("/v1/fulfillment/packing/containers/${urlEncode(containerCode)}"))

    suspend fun pack(containerCode: String): PackResult {
        return json.decodeFromString(PackResult.serializer(), post("/v1/fulfillment/packing/containers/${urlEncode(containerCode)}/pack", "{}"))
    }

    // Shipping
    suspend fun shippingScan(code: String): ShipmentView =
        json.decodeFromString(ShipmentView.serializer(), get("/v1/fulfillment/shipping/shipments/${urlEncode(code)}"))

    suspend fun ship(code: String): ShipResult {
        return json.decodeFromString(ShipResult.serializer(), post("/v1/fulfillment/shipping/shipments/${urlEncode(code)}/ship", "{}"))
    }

    // Trace
    suspend fun trace(code: String): TraceView =
        json.decodeFromString(TraceView.serializer(), get("/v1/fulfillment/articles/${urlEncode(code)}/trace"))

    /** Always destroys local access. False means server revocation was NOT confirmed. */
    suspend fun logout(): Boolean {
        val identity = store.snapshot().identityVersion
        return try {
            post("/v1/auth/logout", "{}", auth = true)
            true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        } finally {
            store.clearIfIdentity(identity)
        }
    }

    private suspend fun get(path: String): String = transport.request("GET", path)
    private suspend fun put(path: String, body: String): String = transport.request("PUT", path, body)
    private suspend fun post(path: String, body: String, auth: Boolean = true): String =
        transport.request("POST", path, body, authenticated = auth)

    private fun urlEncode(value: String): String {
        require(value != "." && value != "..") { "Invalid code." }
        return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
    private fun jq(value: String) = kotlinx.serialization.json.JsonPrimitive(value).toString()
}
