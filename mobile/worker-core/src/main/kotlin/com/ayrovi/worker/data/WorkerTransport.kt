package com.ayrovi.worker.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** API reachability is distinct from Android having a network interface. */
enum class ConnectionState { CHECKING, ONLINE, SYNCING, OFFLINE, SYNC_ERROR, AUTH_ERROR }

class TransportFailure(val outcomeUnknown: Boolean, cause: Throwable? = null) : IOException(
    if (outcomeUnknown) "The server response was lost. The operation may have been recorded."
    else "The warehouse server could not be reached.", cause,
)

class ContractFailure(message: String) : Exception(message)

/** Never apply a response/retry under a different login, even for the same employee. */
class SessionChangedFailure(val outcomeUnknown: Boolean) : Exception("The worker session changed while this request was in progress.")

interface WorkerTransport {
    val connection: StateFlow<ConnectionState>
    suspend fun request(method: String, path: String, body: String? = null, authenticated: Boolean = true): String
    fun networkAvailable(available: Boolean)
}

/**
 * One transport for every native endpoint. No connection retry, redirect, logging interceptor,
 * or offline replay. A definite unauthorized response can be refreshed/retried once.
 */
class HttpWorkerTransport internal constructor(
    baseUrl: String,
    private val store: SessionStorage,
    private val client: OkHttpClient = defaultClient(),
    allowHttpForTests: Boolean = false,
) : WorkerTransport {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl().also {
        require(it.isHttps || (allowHttpForTests && it.host in setOf("localhost", "127.0.0.1"))) {
            "A trusted HTTPS AYROVI API URL is required."
        }
        require(it.username.isEmpty() && it.password.isEmpty() && it.query == null && it.fragment == null) {
            "The API URL must not contain credentials, a query, or a fragment."
        }
    }
    private val json = Json { ignoreUnknownKeys = true }
    private val media = "application/json; charset=utf-8".toMediaType()
    private val refreshMutex = Mutex()
    private val mutableConnection = MutableStateFlow(ConnectionState.CHECKING)
    override val connection = mutableConnection.asStateFlow()
    @Volatile private var networkPresent = true

    override fun networkAvailable(available: Boolean) {
        networkPresent = available
        if (!available) mutableConnection.value = ConnectionState.OFFLINE
        else if (mutableConnection.value == ConnectionState.OFFLINE) mutableConnection.value = ConnectionState.CHECKING
    }

    override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String {
        require(path.startsWith("/v1/") && !path.contains("#")) { "Only versioned worker API paths are supported." }
        if (!networkPresent) throw TransportFailure(outcomeUnknown = false)
        mutableConnection.value = ConnectionState.SYNCING
        var session = store.snapshot()
        try {
            if (authenticated && session.tokens == null) throw WorkerRepository.ApiException(401, "Sign in to continue.")
            var response = exchange(method, path, body, if (authenticated) session.tokens?.accessToken else null)
            if (authenticated && response.status == 401 && path != "/v1/auth/logout") {
                session = refresh(session)
                response = exchange(method, path, body, session.tokens?.accessToken)
            }
            if (authenticated && store.snapshot().identityVersion != session.identityVersion) {
                throw SessionChangedFailure(method != "GET" && response.status != 401 && response.status != 403)
            }
            if (response.status !in 200..299) {
                if (authenticated && response.status == 401) store.clearIfVersion(session.version)
                throw WorkerRepository.ApiException(
                    response.status, errorMessage(response.body),
                    outcomeUnknown = method != "GET" && (response.status >= 500 || response.status == 408 || response.status in 300..399),
                )
            }
            mutableConnection.value = if (networkPresent) ConnectionState.ONLINE else ConnectionState.OFFLINE
            return response.body
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: SessionChangedFailure) {
            // Do not overwrite the new login's connection state or clear its credentials.
            throw failure
        } catch (failure: WorkerRepository.ApiException) {
            mutableConnection.value = when {
                !networkPresent -> ConnectionState.OFFLINE
                failure.code == 401 -> ConnectionState.AUTH_ERROR
                failure.code >= 500 || failure.code == 408 -> ConnectionState.SYNC_ERROR
                else -> ConnectionState.ONLINE // A permission/business refusal is still a reachable API.
            }
            throw failure
        } catch (failure: TransportFailure) {
            mutableConnection.value = if (networkPresent) ConnectionState.SYNC_ERROR else ConnectionState.OFFLINE
            throw failure
        } catch (failure: IOException) {
            mutableConnection.value = if (networkPresent) ConnectionState.SYNC_ERROR else ConnectionState.OFFLINE
            throw TransportFailure(method != "GET", failure)
        }
    }

    private suspend fun refresh(previous: SessionSnapshot): SessionSnapshot = refreshMutex.withLock {
        val current = store.snapshot()
        if (current.identityVersion != previous.identityVersion) throw SessionChangedFailure(false)
        if (current.version != previous.version) {
            if (current.tokens != null) return@withLock current
            throw SessionChangedFailure(false)
        }
        val refreshToken = current.tokens?.refreshToken
            ?: throw WorkerRepository.ApiException(401, "Sign in to continue.")
        val response = try {
            exchange("POST", "/v1/auth/refresh", """{"refreshToken":${JsonPrimitive(refreshToken)}}""", null)
        } catch (failure: IOException) {
            // Rotation might have consumed the old refresh token. Never retry it behind the operator.
            expire(current, "Session renewal could not be verified. Sign in again.")
        }
        if (response.status !in 200..299) {
            if (response.status >= 500 || response.status == 401 || response.status == 403) {
                expire(current, "Your session expired or was revoked. Sign in again.")
            }
            throw WorkerRepository.ApiException(response.status, errorMessage(response.body))
        }
        val tokens = try { json.decodeFromString(AuthTokens.serializer(), response.body) }
        catch (failure: Exception) {
            expire(current, "Session renewal returned an invalid response. Sign in again.")
        }
        if (tokens.accessToken.isBlank() || tokens.refreshToken.isBlank()) expire(current, "Session renewal returned empty credentials.")
        if (!store.replace(current.version, tokens)) throw SessionChangedFailure(false)
        store.snapshot()
    }

    private fun expire(session: SessionSnapshot, message: String): Nothing {
        if (!store.clearIfVersion(session.version)) throw SessionChangedFailure(false)
        throw WorkerRepository.ApiException(401, message)
    }

    private data class Response(val status: Int, val body: String)

    private suspend fun exchange(method: String, path: String, body: String?, access: String?): Response =
        withContext(Dispatchers.IO) {
            // path originates only in repository methods; codes are escaped by urlEncode there.
            val url = "${base.toString().trimEnd('/')}$path".toHttpUrl()
            require(url.host == base.host && url.port == base.port && url.scheme == base.scheme)
            val builder = Request.Builder().url(url).header("Accept", "application/json")
            if (method == "GET") builder.get()
            else builder.method(method, (body ?: "{}").toRequestBody(media))
            access?.let { builder.header("Authorization", "Bearer $it") }
            client.newCall(builder.build()).execute().use { response ->
                Response(response.code, response.body?.string().orEmpty())
            }
        }

    private fun errorMessage(raw: String): String = try {
        val message = json.parseToJsonElement(raw).jsonObject["message"]
        when (message) {
            is JsonPrimitive -> message.contentOrNull
            is JsonArray -> message.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.joinToString("\n")
            else -> null
        }?.takeIf { it.isNotBlank() }?.take(2_000) ?: "The warehouse server could not complete this request."
    } catch (_: Exception) {
        // Never render arbitrary proxy HTML, credentials or stack traces in an operator error.
        "The warehouse server returned an unreadable response."
    }

    companion object {
        fun production(baseUrl: String, store: SessionStorage): HttpWorkerTransport = HttpWorkerTransport(baseUrl, store)
        private fun defaultClient() = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(45, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
