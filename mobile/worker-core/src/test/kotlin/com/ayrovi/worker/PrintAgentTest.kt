package com.ayrovi.worker

import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.WorkerTransport
import com.ayrovi.worker.domain.PrintAgent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.*

/**
 * HANDHELD PRINT AGENT (owner order 2026-09-16, open item «PC → CT40 printer»).
 *
 * The agent is the CT40 side of a label queued by any screen: it reads the
 * pending queue for the worker's own stations and reports the physical
 * outcome. These tests pin the wire contract and the label mapping — the
 * printer itself is covered by the print-queue tests.
 */
class PrintAgentTest {

    private class RecordingTransport(
        private val answer: String = PENDING,
        private val failWrites: Boolean = false,
    ) : WorkerTransport {
        val calls = mutableListOf<Triple<String, String, String?>>()
        override val connection = MutableStateFlow(ConnectionState.ONLINE)
        override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String {
            calls += Triple(method, path, body)
            if (method == "POST" && failWrites) throw IllegalStateException("link down")
            return answer
        }
        override fun networkAvailable(available: Boolean) {}
    }

    private companion object {
        /** Verbatim shape of `GET /v1/print-jobs/pending` (server contract). */
        const val PENDING = """
        {"stations":[{"id":"st1","code":"BATCH-01","name":"Batch"}],
         "jobs":[
          {"id":"job-1","stationId":"st1","target":"SCAN","targetRef":"SA-4471","copies":1,
           "transport":"CT40","display":{"id":"d1","name":"Batch Next Action"},
           "requestedAt":"2026-09-16T18:00:00.000Z",
           "payload":{"title":"SCAN LABEL","code":"SA-4471","kind":"SCAN","quantity":3,
                      "status":"RECEIVED","customer":"Amine Ben Salah",
                      "station":{"code":"BATCH-01"},"worker":{"code":"WORKER006"},
                      "reference":"scan-1","reprint":true,"printedAt":"2026-09-16T18:00:00.000Z"}},
          {"id":"job-2","stationId":"st1","target":"STATION_SUMMARY","targetRef":"BATCH-01","copies":2,
           "transport":"CT40","display":null,"requestedAt":null,
           "payload":{"title":"STATION SUMMARY","scanCount":7,"station":{"code":"BATCH-01"},"printedAt":"x"}}
         ]}
        """
    }

    @Test fun `pending reads the worker agent queue and keeps the server order`() = runBlocking {
        val transport = RecordingTransport()
        val jobs = PrintAgent(transport).pending(limit = 9)

        assertEquals(listOf("GET"), transport.calls.map { it.first })
        assertEquals("/v1/print-jobs/pending?limit=9", transport.calls.single().second)
        assertEquals(null, transport.calls.single().third) // read: no body
        assertEquals(listOf("job-1", "job-2"), jobs.map { it.id })
        assertEquals("CT40", jobs[0].transport)
        assertEquals("BATCH-01", jobs[0].label.lines.firstOrNull { it.startsWith("STATION") }?.removePrefix("STATION: "))
        assertEquals("Batch Next Action", jobs[0].displayName)
        assertEquals(1, jobs[0].copies)
        assertEquals(2, jobs[1].copies)
    }

    @Test fun `the label is the SAME label the browser transport prints`() {
        val transport = RecordingTransport()
        val job = runBlocking { PrintAgent(transport).pending().first() }
        // title → code → kind x qty → customer → station → worker → status → REPRINT
        assertEquals("SCAN LABEL", job.label.title)
        assertEquals("SA-4471", job.label.barcodeValue)
        assertEquals(
            listOf("SA-4471", "SCAN x 3", "CUSTOMER: Amine Ben Salah", "STATION: BATCH-01", "WORKER: WORKER006", "RECEIVED", "REPRINT"),
            job.label.lines,
        )
        // Design-A stock: 60×40 mm, the owner's label size.
        assertEquals(60, job.label.widthMm)
        assertEquals(40, job.label.heightMm)
    }

    @Test fun `a station summary label carries the totals, not a barcode of nothing`() {
        val env = PrintAgent(RecordingTransport())
        val summary = runBlocking { env.pending().last() }
        assertEquals("STATION SUMMARY", summary.label.title)
        assertEquals(null, summary.label.barcodeValue) // nothing to encode → no empty Code128 on paper
        assertTrue(summary.label.lines.any { it == "SCANS: 7" })
        assertTrue(summary.label.lines.any { it == "STATION: BATCH-01" })
    }

    @Test fun `reporting the outcome is a POST with the terminal status and never creates work`() = runBlocking {
        val transport = RecordingTransport(answer = """{"ok":true,"duplicate":false,"status":"PRINTED"}""")
        val agent = PrintAgent(transport)

        assertTrue(agent.report("job-1", printed = true))
        assertEquals("POST", transport.calls.single().first)
        assertEquals("/v1/print-jobs/job-1/result", transport.calls.single().second)
        assertEquals("""{"status":"PRINTED"}""", transport.calls.single().third)
        assertFalse(transport.calls.any { it.second.contains("/actions/") }) // never a display action

        assertTrue(agent.report("job-2", printed = false, error = "LINK_LOST"))
        assertEquals("""{"status":"FAILED","error":"LINK_LOST"}""", transport.calls.last().third)
    }

    @Test fun `a lost report never throws - the job stays QUEUED and is offered again`() = runBlocking {
        val agent = PrintAgent(RecordingTransport(failWrites = true))
        assertFalse(agent.report("job-1", printed = true))
        assertFalse(agent.report("", printed = true)) // no id → nothing sent
    }

    @Test fun `a broken payload degrades to an empty queue, never a crash on the shop floor`() {
        assertEquals(emptyList(), PrintAgent.parseJobs("not json"))
        assertEquals(emptyList(), PrintAgent.parseJobs("{}"))
        assertEquals(emptyList(), PrintAgent.parseJobs("""{"jobs":[]}"""))
        // a job without an id is dropped, the readable ones survive
        assertEquals(listOf("job-1"), PrintAgent.parseJobs("""{"jobs":[{"payload":{}},{"id":"job-1"}]}""").map { it.id })
    }

    @Test fun `the agent only knows the two agent endpoints (no print, no display token)`() = runBlocking {
        val transport = RecordingTransport()
        val agent = PrintAgent(transport)
        agent.pending()
        agent.report("job-1", printed = true)
        assertTrue(transport.calls.all { it.second.startsWith("/v1/print-jobs/") })
        assertEquals(listOf("/v1/print-jobs/pending?limit=5", "/v1/print-jobs/job-1/result"), transport.calls.map { it.second })
    }
}
