package com.ayrovi.worker.data

import com.ayrovi.worker.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
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
 * once (session rotation keeps the same application + device binding on the
 * server side) and retries. A failed refresh means the worker session is
 * gone — the caller is routed back to the login screen.
 */
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

    suspend fun arrivals(): List<ArrivalRow> =
        json.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(ArrivalRow.serializer()),
            get("/v1/receiving/arrivals"),
        )

    suspend fun activeSession(arrivalIdOrCode: String): SessionHeader? {
        val raw = get("/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/active")
        if (raw.isBlank() || raw == "null") return null
        return json.decodeFromString(SessionHeader.serializer(), raw)
    }

    suspend fun startReceiving(arrivalIdOrCode: String): SessionHeader {
        val raw = post(
            "/v1/receiving/arrivals/${urlEncode(arrivalIdOrCode)}/start",
            """{"deviceType":"SMARTPHONE","deviceName":${jsonString(store.deviceCode)},"scanSource":"CAMERA"}""",
        )
        return json.decodeFromString(SessionHeader.serializer(), raw)
    }

    /** Identify a carton by scanned code. Returns the server flash view. */
    suspend fun scanCarton(
        sessionId: String,
        code: String,
        scanType: String,
        operationId: String,
        source: String,
    ): SessionHeader {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/scan-carton",
            """{"code":${jsonString(code)},"scanType":${jsonString(scanType)},"operationId":${jsonString(operationId)},"source":${jsonString(source)}}""",
        )
        return json.decodeFromString(SessionHeader.serializer(), raw)
    }

    /** Confirm an identified carton as physically received (idempotent). */
    suspend fun receiveCarton(sessionId: String, code: String, operationId: String): SessionHeader {
        val raw = post(
            "/v1/receiving/sessions/${urlEncode(sessionId)}/receive-carton",
            """{"cartonId":${jsonString(code)},"operationId":${jsonString(operationId)},"source":"CAMERA"}""",
        )
        return json.decodeFromString(SessionHeader.serializer(), raw)
    }

    suspend fun pauseSession(sessionId: String) {
        post("/v1/receiving/sessions/${urlEncode(sessionId)}/pause", "{}")
    }

    suspend fun logout() {
        try {
            post("/v1/auth/logout", "{}", auth = true)
        } catch (_: Exception) {
            // Local logout must still work even if the network is gone.
        }
        store.clear()
    }

    // ------------------------------------------------------------------
    // transport helpers
    // ------------------------------------------------------------------

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val resp = authGet(path)
        if (!resp.first.isSuccessful) throw ApiException(resp.first.code, bodyMessage(resp.second))
        resp.second
    }

    private suspend fun post(path: String, body: String, auth: Boolean = true): String =
        withContext(Dispatchers.IO) {
            val resp = rawPost("${base()}$path", body, auth = auth)
            if (!resp.first.isSuccessful) throw ApiException(resp.first.code, bodyMessage(resp.second))
            resp.second
        }

    /** GET with automatic single refresh on 401. */
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

    private fun bodyMessage(raw: String): String {
        return try {
            val obj = json.parseToJsonElement(raw).jsonObject
            obj["message"]?.toString()?.trim('"') ?: raw.take(200)
        } catch (_: Exception) {
            raw.take(200)
        }
    }

    private fun urlEncode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    /** JSON-string-encode a value (returns it quoted). */
    private fun jsonString(value: String): String =
        kotlinx.serialization.json.JsonPrimitive(value).toString()
}
