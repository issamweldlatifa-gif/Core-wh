package com.ayrovi.worker.data

import com.ayrovi.worker.BuildConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Thin authenticated client for the native worker surface. */
class WorkerRepository(private val store: SessionStore) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
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

    // ------------------------------------------------------------------
    // Receiving
    // ------------------------------------------------------------------

    suspend fun arrivals(): List<ArrivalRow> =
        json.decodeFromString(ListSerializer(ArrivalRow.serializer()), get("/v1/receiving/arrivals"))

    suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? {
        val raw = get("/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/active")
        if (raw.isBlank() || raw == "null") return null
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession {
        val raw = post(
            "/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/start",
            """{"deviceType":"SMARTPHONE","deviceName":${jsonString(store.deviceCode)},"scanSource":"CAMERA"}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun receivingDetail(sessionId: String): ReceivingSession =
        json.decodeFromString(
            ReceivingSession.serializer(),
            get("/v1/receiving/sessions/${urlEncode(sessionId)}"),
        )

    suspend fun scanCarton(
        sessionId: String,
        code: String,
        scanType: String,
        operationId: String,
        source: String,
    ): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/scan-carton",
            """{"code":${jsonString(code)},"scanType":${jsonString(scanType)},"operationId":${jsonString(operationId)},"source":${jsonString(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun receiveCarton(
        sessionId: String,
        cartonId: String,
        operationId: String,
        source: String,
    ): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/receive-carton",
            """{"cartonId":${jsonString(cartonId)},"operationId":${jsonString(operationId)},"source":${jsonString(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun receiveProduct(
        sessionId: String,
        sku: String,
        quantity: Int,
        operationId: String,
        source: String,
    ): ReceivingSession {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/receive-product",
            """{"sku":${jsonString(sku)},"quantity":${quantity.coerceAtLeast(1)},"operationId":${jsonString(operationId)},"source":${jsonString(source)}}""",
        )
        return json.decodeFromString(ReceivingSession.serializer(), raw)
    }

    suspend fun pauseSession(sessionId: String): ReceivingSession =
        receivingCommand(sessionId, "pause")

    suspend fun resumeSession(sessionId: String): ReceivingSession =
        receivingCommand(sessionId, "resume")

    suspend fun completeSession(sessionId: String): ReceivingSession =
        receivingCommand(sessionId, "complete")

    private suspend fun receivingCommand(sessionId: String, command: String): ReceivingSession =
        json.decodeFromString(
            ReceivingSession.serializer(),
            post("/v1/receiving/sessions/${urlEncode(sessionId)}/$command", "{}"),
        )

    // ------------------------------------------------------------------
    // Putaway
    // ------------------------------------------------------------------

    suspend fun putawayQueue(): List<PutawayQueueCarton> =
        json.decodeFromString(
            ListSerializer(PutawayQueueCarton.serializer()),
            get("/v1/putaway/queue"),
        )

    suspend fun activePutaway(): PutawaySession? {
        val raw = get("/v1/putaway/sessions/active")
        if (raw.isBlank() || raw == "null") return null
        return json.decodeFromString(PutawaySession.serializer(), raw)
    }

    suspend fun startPutaway(): PutawaySession {
        val raw = post(
            "/v1/putaway/sessions/start",
            """{"deviceType":"SMARTPHONE","deviceName":${jsonString(store.deviceCode)}}""",
        )
        return json.decodeFromString(PutawaySession.serializer(), raw)
    }

    suspend fun putawayDetail(sessionId: String): PutawaySession =
        json.decodeFromString(
            PutawaySession.serializer(),
            get("/v1/putaway/sessions/${urlEncode(sessionId)}"),
        )

    suspend fun scanPutawayCarton(code: String): PutawayFlashView =
        json.decodeFromString(
            PutawayFlashEnvelope.serializer(),
            post("/v1/putaway/scan-carton", """{"code":${jsonString(code)}}"""),
        ).flash

    suspend fun scanPutawayLocation(code: String): PutawayFlashView =
        json.decodeFromString(
            PutawayFlashEnvelope.serializer(),
            post("/v1/putaway/scan-location", """{"code":${jsonString(code)}}"""),
        ).flash

    suspend fun placePutaway(
        sessionId: String,
        cartonCode: String,
        locationCode: String,
        cartonSource: String,
        locationSource: String,
    ): PutawayPlaceResponse {
        val raw = post(
            "/v1/putaway/sessions/${urlEncode(sessionId)}/place",
            """{"cartonCode":${jsonString(cartonCode)},"locationCode":${jsonString(locationCode)},"cartonSource":${jsonString(cartonSource)},"locationSource":${jsonString(locationSource)}}""",
        )
        return json.decodeFromString(PutawayPlaceResponse.serializer(), raw)
    }

    suspend fun pausePutaway(sessionId: String): PutawaySession = putawayCommand(sessionId, "pause")
    suspend fun resumePutaway(sessionId: String): PutawaySession = putawayCommand(sessionId, "resume")
    suspend fun completePutaway(sessionId: String): PutawaySession = putawayCommand(sessionId, "complete")

    private suspend fun putawayCommand(sessionId: String, command: String): PutawaySession =
        json.decodeFromString(
            PutawaySession.serializer(),
            post("/v1/putaway/sessions/${urlEncode(sessionId)}/$command", "{}"),
        )

    suspend fun logout() {
        try {
            post("/v1/auth/logout", "{}", auth = true)
        } catch (_: Exception) {
            // Local logout must still work if the network is unavailable.
        }
        store.clear()
    }

    // ------------------------------------------------------------------
    // Transport
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
                resp = rawPost("${base()}$path", body, auth = true)
            }
            if (!resp.first.isSuccessful) throw ApiException(resp.first.code, bodyMessage(resp.second))
            resp.second
        }

    private fun authGet(path: String): Pair<okhttp3.Response, String> {
        var resp = rawGet("${base()}$path", store.accessToken())
        if (resp.first.code == 401 && refreshOnce()) {
            resp = rawGet("${base()}$path", store.accessToken())
        }
        return Pair(resp.first, resp.second)
    }

    private fun refreshOnce(): Boolean {
        val refresh = store.refreshToken() ?: return false
        val req = Request.Builder()
            .url("${base()}/v1/auth/refresh")
            .post("""{"refreshToken":${jsonString(refresh)}}""".toRequestBody(jsonMedia))
            .build()
        return try {
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) return false
                val body = res.body?.string() ?: return false
                val tokens = json.decodeFromString(AuthTokens.serializer(), body)
                store.saveTokens(tokens.accessToken, tokens.refreshToken)
                true
            }
        } catch (_: Exception) {
            false
        }
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

    private fun bodyMessage(raw: String): String = try {
        val obj = json.parseToJsonElement(raw).jsonObject
        obj["message"]?.toString()?.trim('"') ?: raw.take(240)
    } catch (_: Exception) {
        raw.take(240)
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun jsonString(value: String): String = JsonPrimitive(value).toString()
}
