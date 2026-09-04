package com.ayrovi.worker

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID

class WorkerApi(private val baseUrl: String, private val store: WorkerSessionStore) {
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()

    fun login(identifier: String, secret: String): AuthTokens {
        val body = "{\"identifier\":${quote(identifier)},\"secret\":${quote(secret)},\"app\":\"WORKER_NATIVE\"}"
        val request = Request.Builder()
            .url("$baseUrl/v1/auth/login")
            .post(body.toRequestBody(mediaType))
            .build()
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) error("Login failed (${response.code})")
        val root = json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
        return AuthTokens(
            root["accessToken"]?.toString()?.trim('"') ?: error("Missing access token"),
            root["refreshToken"]?.toString()?.trim('"') ?: error("Missing refresh token"),
        ).also(store::save)
    }

    fun context(): WorkerContext {
        val token = store.accessToken() ?: error("Not authenticated")
        val request = Request.Builder()
            .url("$baseUrl/v1/terminal/context")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) error("Worker context failed (${response.code})")
        val root = json.parseToJsonElement(response.body?.string().orEmpty()).jsonObject
        val station = root["station"]
            ?.takeUnless { it is JsonNull }
            ?.let { it as? JsonObject }
            ?.let {
            WorkerStation(
                it["code"]?.toString()?.trim('"').orEmpty(),
                it["name"]?.toString()?.trim('"').orEmpty(),
                it["department"]?.toString()?.trim('"').orEmpty(),
            )
        }
        val tasks = root["tasks"]
            ?.takeUnless { it is JsonNull }
            ?.let { runCatching { it.jsonArray }.getOrNull() }
            ?.mapNotNull { item ->
            val task = item.jsonObject
            val key = task["key"]?.toString()?.trim('"') ?: return@mapNotNull null
            WorkerTask(
                key = key,
                label = task["label"]?.toString()?.trim('"').orEmpty(),
                permission = task["permission"]?.toString()?.trim('"').orEmpty(),
                ready = task["ready"]?.toString()?.toBoolean() == true,
            )
        }.orEmpty()
        return WorkerContext(station, tasks, root["home"]?.toString()?.trim('"').orEmpty())
    }

    fun arrivals(): List<ReceivingArrival> {
        val root = requestJson("/v1/receiving/arrivals")
        return root.jsonArray.mapNotNull { item ->
            val value = item.jsonObject
            val code = value["code"]?.toString()?.trim('"') ?: return@mapNotNull null
            ReceivingArrival(
                id = value["id"]?.toString()?.trim('"').orEmpty(),
                code = code,
                customerName = value["customerName"]?.toString()?.trim('"').orEmpty(),
                status = value["status"]?.toString()?.trim('"').orEmpty(),
                cartons = value["cartons"]?.toString()?.toIntOrNull() ?: 0,
            )
        }
    }

    fun startReceiving(arrivalCode: String): ReceivingSession {
        val root = requestJson(
            "/v1/receiving/arrivals/${encode(arrivalCode)}/start",
            method = "POST",
            body = "{\"deviceType\":\"ANDROID_NATIVE\",\"deviceName\":\"AYROVI Worker\",\"scanSource\":\"MANUAL\"}",
        )
        return sessionFrom(root)
    }

    fun scanCarton(sessionId: String, code: String): ReceivingSession {
        val root = requestJson(
            "/v1/receiving/sessions/${encode(sessionId)}/scan-carton",
            method = "POST",
            body = "{\"code\":${quote(code)},\"scanType\":\"BARCODE\",\"operationId\":${quote(UUID.randomUUID().toString())},\"source\":\"MANUAL\"}",
        )
        return sessionFrom(root)
    }

    fun putawayStart(): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/putaway/sessions/start", "POST",
        "{\"deviceType\":\"ANDROID_NATIVE\",\"deviceName\":\"AYROVI Worker\"}",
    ).jsonObject

    fun putawayScanCarton(code: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/putaway/scan-carton", "POST", "{\"code\":${quote(code)}}",
    ).jsonObject

    fun putawayPlace(sessionId: String, cartonCode: String, locationCode: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/putaway/sessions/${encode(sessionId)}/place", "POST",
        "{\"cartonCode\":${quote(cartonCode)},\"locationCode\":${quote(locationCode)},\"cartonSource\":\"CAMERA\",\"locationSource\":\"CAMERA\"}",
    ).jsonObject

    fun sortingScan(articleCode: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/fulfillment/sorting/articles/${encode(articleCode)}",
    ).jsonObject

    fun sortingStore(articleCode: String, locationCode: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/fulfillment/sorting/store", "POST",
        "{\"articleCode\":${quote(articleCode)},\"locationCode\":${quote(locationCode)}}",
    ).jsonObject

    fun packingScan(containerCode: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/fulfillment/packing/containers/${encode(containerCode)}",
    ).jsonObject

    fun packingPack(containerCode: String): kotlinx.serialization.json.JsonObject = requestJson(
        "/v1/fulfillment/packing/containers/${encode(containerCode)}/pack", "POST", "{}",
    ).jsonObject

    fun logout() = store.clear()

    private fun requestJson(path: String, method: String = "GET", body: String? = null): kotlinx.serialization.json.JsonElement {
        val token = store.accessToken() ?: error("Not authenticated")
        val builder = Request.Builder().url("$baseUrl$path").header("Authorization", "Bearer $token")
        if (method == "POST") builder.post((body ?: "{}").toRequestBody(mediaType)) else builder.get()
        val response = client.newCall(builder.build()).execute()
        if (!response.isSuccessful) error("Request failed (${response.code})")
        return json.parseToJsonElement(response.body?.string().orEmpty())
    }

    private fun sessionFrom(root: kotlinx.serialization.json.JsonElement): ReceivingSession {
        val value = root.jsonObject
        val tally = value["tally"]?.let { runCatching { it.jsonObject }.getOrNull() }
        val flash = value["flash"]?.takeUnless { it is JsonNull }?.let { runCatching { it.jsonObject }.getOrNull() }
        return ReceivingSession(
            id = value["id"]?.toString()?.trim('"').orEmpty(),
            code = value["code"]?.toString()?.trim('"').orEmpty(),
            status = value["status"]?.toString()?.trim('"').orEmpty(),
            expectedCartons = tally?.get("expectedCartons")?.toString()?.toIntOrNull() ?: 0,
            receivedCartons = tally?.get("receivedCartons")?.toString()?.toIntOrNull() ?: 0,
            flashKind = flash?.get("kind")?.toString()?.trim('"'),
            flashMessage = flash?.get("message")?.toString()?.trim('"'),
        )
    }

    private fun encode(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8)

    private fun quote(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
