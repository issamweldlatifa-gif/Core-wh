package com.ayrovi.worker.printer

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors

/**
 * PRINT BRIDGE — the required native bridge for the WEB admin on the CT40
 * (task §4: a browser has no Bluetooth Classic API, so the admin web page
 * calls this loopback HTTP server, which owns the real SPP link).
 *
 * Security/compat:
 *  - bound to 127.0.0.1 ONLY (no other device can reach it);
 *  - answers CORS + Private-Network-Access preflight so https://…onrender.com
 *    may call http://127.0.0.1 from Chrome on the same device;
 *  - optional shared token header X-Print-Token (set once in Admin →
 *    Printers → Advanced).
 */
class PrintBridgeServer(
    private val port: Int = DEFAULT_PORT,
    private val token: String?,
    private val handler: (Request) -> Response,
) : Thread("ayrovi-print-bridge") {

    data class Request(val method: String, val path: String, val body: String)
    data class Response(val status: Int, val body: String)

    @Volatile
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var running = false

    /** Why the bridge could not listen (null = it is listening). */
    @Volatile
    var bindError: String? = null
        private set

    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "print-bridge-req").apply { isDaemon = true } }

    /**
     * Binds BEFORE the thread starts, so the caller knows the truth: a request
     * that can never be answered must not look like a running bridge. (Owner
     * report 2026-09-16: the Admin said «bridge not available» while the app
     * insisted «RUNNING · 127.0.0.1:8787» — the socket had never opened.)
     */
    @Synchronized
    fun open(): Boolean {
        if (running) return true
        return try {
            serverSocket = ServerSocket(port, 8, InetAddress.getLoopbackAddress())
            bindError = null
            running = true
            start()
            true
        } catch (e: Exception) {
            bindError = e.message ?: "the local port $port is not available"
            serverSocket = null
            running = false
            false
        }
    }

    override fun run() {
        while (running) {
            val client = try {
                serverSocket?.accept() ?: break
            } catch (_: Exception) {
                break // socket closed by shutdown(), or the loop is done
            }
            pool.execute { serve(client) }
        }
    }

    private fun serve(client: Socket) {
        try {
            client.use { s ->
                s.soTimeout = 20_000
                val reader = BufferedReader(InputStreamReader(s.inputStream, Charsets.US_ASCII))
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0]
                val path = parts[1].substringBefore('?')
                var contentLength = 0
                var origin: String? = null
                var reqToken: String? = null
                var pna: Boolean = false
                while (true) {
                    val header = reader.readLine() ?: break
                    if (header.isEmpty()) break
                    val idx = header.indexOf(':')
                    if (idx <= 0) continue
                    val key = header.substring(0, idx).trim()
                    val value = header.substring(idx + 1).trim()
                    when (key.lowercase()) {
                        "content-length" -> contentLength = value.toIntOrNull() ?: 0
                        "origin" -> origin = value
                        "access-control-request-private-network" -> pna = value.equals("true", true)
                        "x-print-token" -> reqToken = value
                    }
                }
                val body = if (contentLength > 0) {
                    val buf = CharArray(contentLength)
                    var read = 0
                    while (read < contentLength) {
                        val n = reader.read(buf, read, contentLength - read)
                        if (n < 0) break
                        read += n
                    }
                    String(buf, 0, read)
                } else ""

                if (method == "OPTIONS") {
                    respond(s, 204, "", origin, pna)
                    return
                }
                if (token != null && token.isNotBlank() && reqToken != token) {
                    respond(s, 401, """{"error":"BAD_TOKEN"}""", origin, pna)
                    return
                }
                val response = try {
                    handler(Request(method, path, body))
                } catch (e: Exception) {
                    Response(500, """{"error":"BRIDGE_ERROR","detail":"${jsonEscape(e.message ?: "unknown")}"}""")
                }
                respond(s, response.status, response.body, origin, pna)
            }
        } catch (_: Exception) {
            // A malformed single request must never take the bridge down.
        }
    }

    private fun respond(socket: Socket, status: Int, body: String, origin: String?, pna: Boolean) {
        val allowOrigin = origin?.takeIf { it.startsWith("http") } ?: "*"
        val headers = buildString {
            append("HTTP/1.1 ").append(status).append(' ').append(statusText(status)).append("\r\n")
            append("Content-Type: application/json\r\n")
            append("Content-Length: ").append(body.toByteArray(Charsets.UTF_8).size).append("\r\n")
            append("Access-Control-Allow-Origin: ").append(allowOrigin).append("\r\n")
            append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
            append("Access-Control-Allow-Headers: Content-Type, X-Print-Token\r\n")
            append("Access-Control-Max-Age: 600\r\n")
            if (pna) append("Access-Control-Allow-Private-Network: true\r\n")
            append("Connection: close\r\n\r\n")
        }
        try {
            socket.getOutputStream().let { out ->
                out.write(headers.toByteArray(Charsets.US_ASCII))
                out.write(body.toByteArray(Charsets.UTF_8))
                out.flush()
            }
        } catch (_: java.io.IOException) { /* client gone */ }
    }

    fun shutdown() {
        running = false
        try { serverSocket?.close() } catch (_: java.io.IOException) { /* closing */ }
        serverSocket = null
        pool.shutdownNow()
    }

    private fun statusText(status: Int) = when (status) {
        200 -> "OK"; 204 -> "No Content"; 400 -> "Bad Request"; 401 -> "Unauthorized"
        404 -> "Not Found"; 409 -> "Conflict"; 500 -> "Server Error"; else -> "Status"
    }

    companion object {
        const val DEFAULT_PORT = 8787
        fun jsonEscape(value: String): String = value
            .replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    }
}
