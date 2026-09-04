package com.ayrovi.worker

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

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
        val station = root["station"]?.jsonObject?.let {
            WorkerStation(
                it["code"]?.toString()?.trim('"').orEmpty(),
                it["name"]?.toString()?.trim('"').orEmpty(),
                it["department"]?.toString()?.trim('"').orEmpty(),
            )
        }
        val tasks = root["tasks"]?.jsonArray?.mapNotNull { item ->
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

    fun logout() = store.clear()

    private fun quote(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
