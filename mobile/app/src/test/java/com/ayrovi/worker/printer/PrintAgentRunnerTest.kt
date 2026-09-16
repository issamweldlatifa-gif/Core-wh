package com.ayrovi.worker.printer

import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.WorkerTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * HANDHELD PRINT AGENT — the runner half (open item «PC → CT40 printer»).
 *
 * Proves the three things that matter on the shop floor: a label queued by a
 * screen actually reaches the paired printer, the outcome is reported back, and
 * nothing is printed twice / nothing is printed without a printer.
 */
class PrintAgentRunnerTest {

    private class FakeTransport(
        var pending: String = TWO_JOBS,
        var failPending: Boolean = false,
    ) : WorkerTransport {
        val calls = mutableListOf<Pair<String, String>>()
        val bodies = mutableListOf<String?>()
        override val connection = MutableStateFlow(ConnectionState.ONLINE)
        override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String {
            calls += method to path
            bodies += body
            if (failPending && method == "GET") throw IllegalStateException("OFFLINE")
            return if (method == "GET") pending else """{"ok":true}"""
        }
        override fun networkAvailable(available: Boolean) {}
        fun reports(): List<String?> = calls.indices.filter { calls[it].first == "POST" }.map { bodies[it] }
    }

    private fun runner(
        transport: FakeTransport = FakeTransport(),
        printerTransport: FakePrinterTransport = FakePrinterTransport(),
        persistence: FakeAgentPersistence = FakeAgentPersistence().apply {
            saved = PrinterInfo("PM-241-BT", "E9:BD:F6:4B:95:40")
        },
    ): PrintAgentRunner {
        val mgr = PrinterManager(
            persistence, printerTransport, FakeAgentFinder(),
            PrintQueue(printerTransport, persistence),
        )
        val scope = CoroutineScope(kotlinx.coroutines.SupervisorJob())
        return PrintAgentRunner(transport, mgr, persistence, scope, intervalMs = 1_000)
    }

    private companion object {
        const val TWO_JOBS = """
        {"stations":[{"id":"st1","code":"BATCH-01"}],"jobs":[
          {"id":"job-1","stationId":"st1","target":"SCAN","targetRef":"SA-4471","copies":1,"transport":"CT40",
           "payload":{"title":"SCAN LABEL","code":"SA-4471","kind":"SCAN"}},
          {"id":"job-2","stationId":"st1","target":"SCAN","targetRef":"SA-9982","copies":2,"transport":"CT40",
           "payload":{"title":"SCAN LABEL","code":"SA-9982"}}
        ]}
        """
    }

    @Test fun `a queued label is printed and reported PRINTED to the server`() = runTest {
        val transport = FakeTransport()
        val printed = FakePrinterTransport()
        val agent = runner(transport, printed)

        assertEquals(3, agent.tick()) // job-1 (1 copy) + job-2 (2 copies)
        assertEquals(3, printed.writes)
        assertEquals(listOf("GET"), transport.calls.map { it.first }.filter { it == "GET" })
        assertEquals("/v1/print-jobs/pending?limit=5", transport.calls.first().second)
        // one report per JOB (the server holds `copies`), after the paper moved
        assertEquals(
            listOf("""{"status":"PRINTED"}""", """{"status":"PRINTED"}"""),
            transport.reports(),
        )
        assertEquals(
            listOf("/v1/print-jobs/job-1/result", "/v1/print-jobs/job-2/result"),
            transport.calls.filter { it.first == "POST" }.map { it.second },
        )
        assertEquals(3, agent.printedLabels)
        assertNull(agent.lastError)
    }

    @Test fun `a re-poll never prints the same label twice (duplicate protection by job id)`() = runTest {
        val transport = FakeTransport()
        val printed = FakePrinterTransport()
        val agent = runner(transport, printed)

        assertEquals(3, agent.tick())
        assertEquals(0, agent.tick()) // same queue, nothing new on paper
        assertEquals(3, printed.writes)
    }

    @Test fun `no printer paired on this device means the agent does nothing at all`() = runTest {
        val transport = FakeTransport()
        val agent = runner(transport, FakePrinterTransport(), FakeAgentPersistence())
        assertEquals(0, agent.tick())
        assertTrue(transport.calls.isEmpty()) // not even a network call
        assertNull(agent.lastError)
    }

    @Test fun `a failed write reports FAILED and stops the cycle instead of hammering the link`() = runTest {
        val transport = FakeTransport()
        val printed = FakePrinterTransport(failWrite = true)
        val agent = runner(transport, printed)

        assertEquals(0, agent.tick())
        assertEquals(1, printed.writes) // stopped after the first failure
        assertEquals("""{"status":"FAILED","error":"LINK_LOST"}""", transport.reports().single())
        assertEquals("LINK_LOST", agent.lastError)
    }

    @Test fun `an offline server is not an error the operator must fix`() = runTest {
        val transport = FakeTransport(failPending = true)
        val printed = FakePrinterTransport()
        val agent = runner(transport, printed)

        assertEquals(0, agent.tick())
        assertEquals(0, printed.writes)
        assertEquals("OFFLINE", agent.lastError)
        assertTrue(transport.reports().isEmpty())
    }

    @Test fun `a copy run that stops half-way is FAILED, never a half-true PRINTED`() = runTest {
        val transport = FakeTransport()
        val printed = FakePrinterTransport(failAfter = 1) // the 2nd write of the cycle fails
        val agent = runner(transport, printed)

        // job-1 (1 copy) printed; job-2's first copy is the write that dies
        assertEquals(1, agent.tick())
        assertEquals(2, printed.writes)
        assertEquals("LINK_LOST", agent.lastError)
        assertEquals(
            listOf("""{"status":"PRINTED"}""", """{"status":"FAILED","error":"LINK_LOST"}"""),
            transport.reports(),
        )
    }

    @Test fun `the printed label is the Design-A stock used everywhere else`() = runTest {
        val printed = FakePrinterTransport()
        val transport = FakeTransport()
        val agent = runner(transport, printed)

        agent.tick()
        val tspl = String(printed.lastBytes, Charsets.US_ASCII)
        assertTrue(tspl.startsWith("SIZE 60 mm,40 mm"), tspl.lineSequence().first())
        assertTrue(tspl.contains("BARCODE"), tspl)
        assertTrue(tspl.contains("\"SA-4471\"") || tspl.contains("\"SA-9982\""), tspl)
        assertTrue(tspl.trimEnd().endsWith("PRINT 1,1"), tspl.takeLast(40))
    }

    @Test fun `the loop reports liveness to the terminal without touching the printer`() = runTest {
        val cycles = mutableListOf<Pair<Int, String?>>()
        val persistence = FakeAgentPersistence().apply { saved = PrinterInfo("PM-241-BT", "E9:BD:F6:4B:95:40") }
        val mgr = PrinterManager(persistence, FakePrinterTransport(), FakeAgentFinder(), PrintQueue(FakePrinterTransport(), persistence))
        val runner = PrintAgentRunner(
            FakeTransport(), mgr, persistence, CoroutineScope(kotlinx.coroutines.SupervisorJob()),
            intervalMs = 5, onCycle = { n, e -> cycles += n to e },
        )
        runner.tick()
        assertTrue(cycles.isNotEmpty())
        assertFalse(runner.running) // tick() alone never starts the loop
        runner.start()
        assertTrue(runner.running)
        runner.stop()
        assertFalse(runner.running)
    }
}

/** Printer doubles (same behaviour the printer tests use, kept local). */
private class FakePrinterTransport(var failWrite: Boolean = false, private val failAfter: Int = -1) : PrinterTransport {
    var writes = 0
    var lastBytes = ByteArray(0)
    private var open = false
    override val connected: Boolean get() = open
    override fun connect(address: String) { open = true }
    override fun write(data: ByteArray) {
        writes += 1
        lastBytes = data
        if (failWrite || (failAfter >= 0 && writes > failAfter)) {
            throw PrinterException(PrinterError("LINK_LOST", "Printer connection lost."))
        }
    }
    override fun disconnect() { open = false }
}

private class FakeAgentFinder : PrinterFinder {
    override fun bonded(): List<PrinterInfo> = listOf(PrinterInfo("PM-241-BT", "E9:BD:F6:4B:95:40"))
    override fun startScan(onDevice: (PrinterInfo) -> Unit, onFinished: () -> Unit): Boolean { onFinished(); return true }
    override fun stopScan() {}
}

private class FakeAgentPersistence : PrinterPersistence {
    var saved: PrinterInfo? = null
    private val jobs = LinkedHashSet<String>()
    override fun loadSaved(): PrinterInfo? = saved
    override fun saveSaved(printer: PrinterInfo) { saved = printer }
    override fun clearSaved() { saved = null }
    override fun seenJob(jobId: String): Boolean = jobs.contains(jobId)
    override fun rememberJob(jobId: String) { jobs.add(jobId) }
    override fun bridgeEnabled(): Boolean = true
    override fun setBridgeEnabled(enabled: Boolean) {}
}
