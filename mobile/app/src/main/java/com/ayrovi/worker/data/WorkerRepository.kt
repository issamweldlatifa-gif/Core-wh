package com.ayrovi.worker.data

import com.ayrovi.worker.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Thin authenticated client to the AYROVI Warehouse Core API.
 *
 * Only worker-surface endpoints are ever called. Every request is bound to
 * the session tokens stored by [SessionStore]; on 401 the client refreshes
 * once and retries. A failed refresh means the worker session is gone —
 * the caller is routed back to the login screen.
 */
class WorkerRepository(private val store: SessionStore) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; isLenient = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    class ApiException(val code: Int, override val message: String) : Exception(message)

    private fun base() = BuildConfig.API_BASE_URL.trimEnd('/')

    suspend fun login(identifier: String, secret: String, mode: String?, deviceCode: String): AuthTokens =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(
                LoginRequest.serializer(),
                LoginRequest(
                    identifier = identifier.trim(),
                    secret = secret,
                    mode = mode,
                    app = "WORKER_NATIVE",
                    deviceId = deviceCode,
                ),
            )
            val res = rawPost("${base()}/v1/auth/login", body, auth = false)
            if (!res.first.isSuccessful) throw ApiException(res.first.code, bodyMessage(res.second))
            val tokens = json.decodeFromString(AuthTokens.serializer(), res.second)
            store.employeeCode = identifier.trim()
            store.saveTokens(tokens.accessToken, tokens.refreshToken)
            tokens
        }

    suspend fun me(): MeResponse =
        json.decodeFromString(MeResponse.serializer(), get("/v1/auth/me"))

    suspend fun terminalContext(): TerminalContext =
        json.decodeFromString(TerminalContext.serializer(), get("/v1/terminal/context"))

    suspend fun assignments(): AssignmentsResponse =
        json.decodeFromString(AssignmentsResponse.serializer(), get("/v1/terminal/assignments"))

    suspend fun completeAssignment(id: String) {
        post("/v1/terminal/assignments/${urlEncode(id)}/complete", "{}")
    }

    // ---------------- RECEIVING (legacy per-session reconcile) ----------------
    suspend fun arrivals(): List<ArrivalRow> =
        json.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(ArrivalRow.serializer()),
            get("/v1/receiving/arrivals"),
        )

    suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? {
        val raw = get("/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/active")
        if (raw.isBlank() || raw == "null") return null
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession {
        val raw = post(
            "/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/start",
            """{"deviceType":"SMARTPHONE","deviceName":${jq(store.deviceCode)},"scanSource":"CAMERA"}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun scanCarton(
        sessionId: String, code: String, scanType: String, operationId: String, source: String,
    ): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/scan-carton",
            """{"code":${jq(code)},"scanType":${jq(scanType)},"operationId":${jq(operationId)},"source":${jq(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun receiveCarton(sessionId: String, cartonId: String, operationId: String, source: String): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/receive-carton",
            """{"cartonId":${jq(cartonId)},"operationId":${jq(operationId)},"source":${jq(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun receiveProduct(sessionId: String, sku: String, qty: Int, operationId: String, source: String): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/receive-product",
            """{"sku":${jq(sku)},"quantity":${qty.coerceAtLeast(1)},"operationId":${jq(operationId)},"source":${jq(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun pauseSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "pause")
    suspend fun resumeSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "resume")
    suspend fun completeSession(sessionId: String): ReceivingSession = receivingCommand(sessionId, "complete")

    private suspend fun receivingCommand(sessionId: String, command: String): ReceivingSession =
        json.decodeFromString(
            ReceivingSession.serializer(),
            post("/v1/receiving/sessions/${urlEncode(sessionId)}/$command", "{}"),
        )

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

    suspend fun scanArticleAtReceiving(sessionId: String, sku: String, containerCode: String, cartonCode: String? = null): ArticleScanResult {
        val body = buildString {
            append("""{"sku":${jq(sku)},"containerCode":${jq(containerCode)}""")
            if (cartonCode != null) append(""","cartonCode":${jq(cartonCode)}""")
            append("}")
        }
        return json.decodeFromString(
            ArticleScanResult.serializer(),
            post("/v1/fulfillment/receiving/sessions/${urlEncode(sessionId)}/scan-article", body),
        )
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

    // Logout
    suspend fun logout() {
        try { post("/v1/auth/logout", "{}", auth = true) } catch (_: Exception) { }
        store.clear()
    }

    // ------------------------------------------------------------------
    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val resp = authGet(path)
        if (!resp.first.isSuccessful) throw ApiException(resp.first.code, bodyMessage(resp.second))
        resp.second
    }

    private suspend fun post(path: String, body: String, auth: Boolean = true): String =
        withContext(Dispatchers.IO) {
            var resp = rawPost("${base()}$path", body, auth = auth)
            if (auth && resp.first.code == 401 && refreshOnce()) {
                resp.first.close()
                resp = rawPost("${base()}$path", body, auth = true)
            }
            if (!resp.first.isSuccessful) throw ApiException(resp.first.code, bodyMessage(resp.second))
            resp.second
        }

    private fun authGet(path: String): Pair<okhttp3.Response, String> {
        var resp = rawGet("${base()}$path", store.accessToken())
        if (resp.first.code == 401 && refreshOnce()) {
            resp.first.close()
            resp = rawGet("${base()}$path", store.accessToken())
        }
        return Pair(resp.first, resp.second)
    }

    private fun refreshOnce(): Boolean {
        val refresh = store.refreshToken() ?: return false
        val req = Request.Builder()
            .url("${base()}/v1/auth/refresh")
            .post("""{"refreshToken":${jq(refresh)}}""".toRequestBody(jsonMedia))
            .build()
        return try {
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return false
                val body = res.body?.string() ?: return false
                val tokens = json.decodeFromString(AuthTokens.serializer(), body)
                store.saveTokens(tokens.accessToken, tokens.refreshToken)
                true
            }
        } catch (_: Exception) { false }
    }

    private fun rawGet(url: String, token: String?): Pair<okhttp3.Response, String> {
        val builder = Request.Builder().url(url).get()
        token?.let { builder.header("Authorization", "Bearer $it") }
        return execute(builder.build())
    }

    private fun rawPost(url: String, body: String, auth: Boolean): Pair<okhttp3.Response, String> {
        val builder = Request.Builder().url(url).post(body.toRequestBody(jsonMedia))
        if (auth) store.accessToken()?.let { builder.header("Authorization", "Bearer $it") }
        return execute(builder.build())
    }

    private fun execute(request: Request): Pair<okhttp3.Response, String> {
        val res = client.newCall(request).execute()
        val body = res.body?.string() ?: ""
        return Pair(res, body)
    }

    private fun bodyMessage(raw: String): String {
        return try {
            val obj = json.parseToJsonElement(raw).jsonObject
            obj["message"]?.toString()?.trim('"') ?: raw.take(200)
        } catch (_: Exception) { raw.take(200) }
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun jq(value: String): String =
        kotlinx.serialization.json.JsonPrimitive(value).toString()
}
