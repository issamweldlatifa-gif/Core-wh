package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import kotlin.test.*

/**
 * Scan → device-side match → shared workflow → real WorkerRepository/HTTP →
 * backend-shaped response. Not live AYROVI DB certification: it pins the
 * HTTP contract of the card-based receiving rebuild (confirm-product /
 * confirm-carton / mismatch, no legacy scan/receive routes).
 */
class ReceivingHttpJourneyTest {
    @Test fun `card based product carton mismatch and completion HTTP journey`() = runBlocking {
        val server = MockWebServer()
        val json = Json { encodeDefaults = true }
        var session = ReceivingBackend.session().let { original -> original.copy(
            productCards = original.productCards.map { it.copy(expected = 1, received = 0, remaining = 1) },
            cartonCards = original.cartonCards.map { it.copy(cartonNumber = 1, totalCartons = 1) },
            tally = original.tally.copy(expectedUnits = 1, shortUnits = 1, expectedCartons = 1)
        ) }
        var productWrites = 0
        var cartonWrites = 0
        var mismatchWrites = 0
        val routes = mutableListOf<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                routes += "${request.method} ${request.path}"
                if (request.getHeader("Authorization") != "Bearer old-access") return MockResponse().setResponseCode(401)
                val path = request.path.orEmpty()
                val body = when {
                    path.endsWith("/receiving/arrivals") -> """[{"id":"arrival","code":"WAR-001","cartons":1,"units":1}]"""
                    path.endsWith("/WAR-001/active") -> json.encodeToString(ReceivingSession.serializer(), session)
                    path.endsWith("/confirm-product") -> {
                        val payload = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        check(payload.keys == setOf("identifier", "identifierType", "quantity", "operationId", "source", "startedAt"))
                        check(payload["quantity"]?.jsonPrimitive?.content == "1")
                        productWrites++
                        if (payload["identifier"]?.jsonPrimitive?.content.equals("Sku/a-01", ignoreCase = true)) {
                            session = session.copy(
                                productCards = session.productCards.map { it.copy(received = 1, remaining = 0, status = "RECEIVED") },
                                tally = session.tally.copy(receivedUnits = 1, receivedProducts = 1, shortUnits = 0),
                                flash = FlashView(kind = "MATCH", cardType = "PRODUCT", code = "Sku/a-01"),
                            )
                        } else {
                            session = session.copy(flash = FlashView(kind = "MISMATCH", cardType = "PRODUCT", code = payload["identifier"]?.jsonPrimitive?.content))
                        }
                        json.encodeToString(ReceivingSession.serializer(), session)
                    }
                    path.endsWith("/confirm-carton") -> {
                        val payload = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        check(payload.keys == setOf("identifier", "identifierType", "operationId", "source", "startedAt"))
                        cartonWrites++
                        if (payload["identifier"]?.jsonPrimitive?.content.equals("CTN-001", ignoreCase = true) ||
                            payload["identifier"]?.jsonPrimitive?.content.equals("TRK-001", ignoreCase = true)
                        ) {
                            session = session.copy(
                                cartonCards = session.cartonCards.map { it.copy(status = "RECEIVED") },
                                tally = session.tally.copy(receivedCartons = 1, missingCartons = 0),
                                flash = FlashView(kind = "MATCH", cardType = "CARTON", code = "CTN-001"),
                            )
                        } else {
                            session = session.copy(flash = FlashView(kind = "MISMATCH", cardType = "CARTON", code = payload["identifier"]?.jsonPrimitive?.content))
                        }
                        json.encodeToString(ReceivingSession.serializer(), session)
                    }
                    path.endsWith("/mismatch") -> {
                        val payload = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        check(payload.keys == setOf("cardType", "identifier", "identifierType", "source", "startedAt"))
                        mismatchWrites++
                        json.encodeToString(ReceivingSession.serializer(), session.copy(
                            flash = FlashView(kind = "MISMATCH", cardType = payload["cardType"]?.jsonPrimitive?.content, code = payload["identifier"]?.jsonPrimitive?.content)))
                    }
                    path.endsWith("/complete") -> { session = session.copy(status = "COMPLETED"); json.encodeToString(ReceivingSession.serializer(), session) }
                    path.endsWith("/sessions/session") -> json.encodeToString(ReceivingSession.serializer(), session)
                    else -> return MockResponse().setResponseCode(404).setBody("""{"message":"Not found."}""")
                }
                return MockResponse().setResponseCode(if (request.method == "POST") 201 else 200).setBody(body)
            }
        }
        server.start()
        try {
            val sessions = MemorySessions().apply { signIn() }
            val journal = MemoryJournal()
            val repository = WorkerRepository(sessions, HttpWorkerTransport(server.url("/api").toString(), sessions, allowHttpForTests = true))
            val permissions = setOf("receiving.view", "receiving.execute")
            val flow = ReceivingWorkflow(repository, journal, "worker", permissions, this)
            val scanner = ScannerManager(initiallyEnabled = true)
            suspend fun settle() { withTimeout(5_000) { flow.state.first { !it.busy } } }
            suspend fun scan(code: String) { flow.scan(scanner.capture(code, ScanSource.EXTERNAL_SCANNER)!!); settle() }

            flow.updateAccess(permissions, true); flow.initialize(); settle()
            scan("WAR-001")
            assertEquals(ReceivingStep.CARTON, flow.state.value.step)

            // CARTON lane: local carton card match, explicit confirm, one write.
            scan("CTN-001")
            assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step)
            assertEquals(0, cartonWrites)
            flow.confirmCard(); settle()
            assertEquals(1, cartonWrites)
            assertEquals(1, session.tally.receivedCartons)

            // PRODUIT lane: local product card match, explicit confirm, one write.
            flow.selectMode(ReceivingMode.PRODUCTS); settle()
            scan("Sku/a-01")
            assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
            assertEquals(0, productWrites)
            flow.confirmCard(); settle()
            assertEquals(1, productWrites)
            assertEquals(1, session.tally.receivedUnits)

            // Device mismatch is logged through /mismatch, never confirmed.
            scan("UNKNOWN-CODE")
            assertEquals(1, mismatchWrites)

            flow.reviewCompletion(); settle(); flow.complete(); settle()
            assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)

            // New card-based contract only — no legacy receiving routes at all.
            assertTrue(routes.contains("POST /api/v1/receiving/sessions/session/confirm-product"))
            assertTrue(routes.contains("POST /api/v1/receiving/sessions/session/confirm-carton"))
            assertTrue(routes.contains("POST /api/v1/receiving/sessions/session/mismatch"))
            assertFalse(routes.any { it.contains("scan-carton") }, "legacy scan-carton must be gone")
            assertFalse(routes.any { it.contains("receive-carton") }, "legacy receive-carton must be gone")
            assertFalse(routes.any { it.contains("scan-article") }, "legacy scan-article must be gone")
        } finally { server.shutdown() }
    }
}
