package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import kotlin.test.*

/** Scan → shared workflow → real WorkerRepository/HTTP → contract-server response. Not live AYROVI DB certification. */
class ReceivingHttpJourneyTest {
    @Test fun `complete arrival carton tote product acknowledgement and completion HTTP journey`() = runBlocking {
        val server = MockWebServer()
        val json = Json { encodeDefaults = true }
        var session = ReceivingBackend.session().let { original -> original.copy(
            products = original.products.map { it.copy(expected = 1, received = 0, remaining = 1, difference = -1) },
            tally = original.tally.copy(expectedUnits = 1, shortUnits = 1)) }
        var articleWrites = 0
        val routes = mutableListOf<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                routes += "${request.method} ${request.path}"
                if (request.getHeader("Authorization") != "Bearer old-access") return MockResponse().setResponseCode(401)
                val path = request.path.orEmpty()
                val body = when {
                    path.endsWith("/receiving/arrivals") -> """[{"id":"arrival","code":"WAR-001","cartons":1,"units":1}]"""
                    path.endsWith("/WAR-001/active") -> json.encodeToString(ReceivingSession.serializer(), session)
                    path.endsWith("/scan-carton") -> json.encodeToString(ReceivingSession.serializer(), session.copy(
                        flash = FlashView(kind = "CARTON_IDENTIFIED", carton = Json.parseToJsonElement("""{"id":"carton","externalCartonId":"CTN-001"}"""))))
                    path.endsWith("/receive-carton") -> {
                        val payload = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        check(payload["cartonId"]?.jsonPrimitive?.content == "carton")
                        session = session.copy(receivedCartonEvents = listOf(CartonEvent(cartonId = "CTN-001", status = "RECEIVED")),
                            tally = session.tally.copy(receivedCartons = 1, missingCartons = 0))
                        json.encodeToString(ReceivingSession.serializer(), session)
                    }
                    path.endsWith("/containers/RCN-000001") -> """{"code":"RCN-000001","type":"RECEIVING","status":"ACTIVE"}"""
                    path.endsWith("/scan-article") -> {
                        val payload = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        check(payload.keys == setOf("sku", "containerCode", "cartonCode", "operationId"))
                        check(payload["sku"]?.jsonPrimitive?.content == "Sku/a-01")
                        check(payload["cartonCode"]?.jsonPrimitive?.content == "CTN-001")
                        articleWrites++
                        session = session.copy(products = session.products.map { it.copy(received = 1, remaining = 0, difference = 0) },
                            tally = session.tally.copy(receivedUnits = 1, receivedProducts = 1, shortUnits = 0))
                        """{"flash":{"kind":"ARTICLE_RECEIVED","article":{"code":"ART-HTTP-001"}},"matched":true}"""
                    }
                    path.endsWith("/complete") -> { session = session.copy(status = "COMPLETED"); json.encodeToString(ReceivingSession.serializer(), session) }
                    path.endsWith("/sessions/session") -> json.encodeToString(ReceivingSession.serializer(), session)
                    else -> return MockResponse().setResponseCode(404).setBody("""{"message":"Arrival not found."}""")
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
            scan("CTN-001")
            assertEquals(0, session.tally.receivedCartons)
            flow.confirmCarton(); settle()
            assertEquals(1, session.tally.receivedCartons)
            flow.selectMode(ReceivingMode.PRODUCTS); settle()
            scan("RCN-000001"); scan("Sku/a-01")
            assertEquals(0, articleWrites)
            flow.confirmProduct(); settle()
            assertEquals(1, articleWrites)
            assertEquals("ART-HTTP-001", journal.read()!!.confirmedReceipt!!.articleCode)
            flow.nextProduct(); settle()
            assertNull(journal.read())
            flow.reviewCompletion(); settle(); flow.complete(); settle()
            assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)
            assertTrue(routes.contains("POST /api/v1/fulfillment/receiving/sessions/session/scan-article"))
            assertFalse(routes.any { it.contains("receive-product") })
        } finally { server.shutdown() }
    }
}
