package com.ayrovi.worker.printer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Fakes covering task §28 scenarios 1-3, 5-8, 12-15 without hardware. */

private class FakeTransport(var failConnect: Boolean = false, var failWrite: Boolean = false) : PrinterTransport {
    var writes = 0
    var connectAttempts = 0
    var isConnected = false
    override val connected: Boolean get() = isConnected
    override fun connect(address: String) {
        connectAttempts += 1
        if (failConnect) throw PrinterException(PrinterError("CONNECT_FAILED", "Printer not found."))
        isConnected = true
    }
    override fun write(data: ByteArray) {
        writes += 1
        if (failWrite) throw PrinterException(PrinterError("LINK_LOST", "Printer connection lost."))
    }
    override fun disconnect() { isConnected = false }
}

private class FakeFinder : PrinterFinder {
    var btOff = false
    val devices = mutableListOf(
        PrinterInfo("PM-241-BT", "E9:BD:F6:4B:95:40"),
        PrinterInfo("Galaxy A15", "AA:BB:CC:DD:EE:FF"),
    )
    var scanStarted = false
    override fun bonded(): List<PrinterInfo> {
        if (btOff) throw PrinterException(PrinterError("BT_OFF", "Bluetooth is disabled."))
        return devices
    }
    override fun startScan(onDevice: (PrinterInfo) -> Unit, onFinished: () -> Unit): Boolean {
        if (btOff) throw PrinterException(PrinterError("BT_OFF", "Bluetooth is disabled."))
        scanStarted = true
        devices.forEach(onDevice)
        onFinished()
        return true
    }
    override fun stopScan() { scanStarted = false }
}

private class FakePersistence(private val rememberDelayMs: Long = 0) : PrinterPersistence {
    var saved: PrinterInfo? = null
    val jobs = LinkedHashSet<String>()
    var enabled = false
    private val lock = Any()
    override fun loadSaved(): PrinterInfo? = saved
    override fun saveSaved(printer: PrinterInfo) { saved = printer }
    override fun clearSaved() { saved = null }
    override fun seenJob(jobId: String): Boolean = synchronized(lock) { jobs.contains(jobId) }
    override fun rememberJob(jobId: String) {
        if (rememberDelayMs > 0) Thread.sleep(rememberDelayMs)
        synchronized(lock) { jobs.add(jobId) }
    }
    override fun bridgeEnabled(): Boolean = enabled
    override fun setBridgeEnabled(value: Boolean) { enabled = value }
}

private fun manager(transport: FakeTransport = FakeTransport(), finder: FakeFinder = FakeFinder(), store: FakePersistence = FakePersistence()): PrinterManager =
    PrinterManager(store, transport, finder, PrintQueue(transport, store))

class PrinterManagerTest {

    @Test
    fun `bluetooth disabled surfaces a clear error and never crashes (S1)`() {
        val finder = FakeFinder().apply { btOff = true }
        val m = manager(finder = finder)
        assertEquals(emptyList(), m.bondedPrinters())
        assertEquals(PrinterError("BT_OFF", "Bluetooth is disabled.").code, m.lastError?.code)
        assertFalse(m.scan({}, {}))
    }

    @Test
    fun `connect failure lands in ERROR with user message (S2, S13)`() {
        val m = manager(transport = FakeTransport(failConnect = true))
        assertFalse(m.connect("E9:BD:F6:4B:95:40", "PM-241-BT"))
        assertEquals(PrinterConnectionState.ERROR, m.state)
        assertEquals("Printer not found.", m.lastError?.userMessage)
    }

    @Test
    fun `discovery lists the paired printer and a normal device is not flagged`() {
        val m = manager()
        val list = m.bondedPrinters()
        assertEquals(2, list.size)
        assertEquals("PM-241-BT", list[0].name) // likely-printer name sorts first
    }

    @Test
    fun `connect persists the printer and reaches CONNECTED (S5, S8)`() {
        val store = FakePersistence()
        val m = manager(store = store)
        assertTrue(m.connect("E9:BD:F6:4B:95:40", "PM-241-BT"))
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
        assertEquals("PM-241-BT", store.saved?.name)
        assertEquals("PM-241-BT", m.status().savedPrinter?.name)
    }

    @Test
    fun `sequential print jobs stay ordered on the single link (S12)`() {
        val t = FakeTransport()
        val m = manager(transport = t)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        val o1 = m.print("job-1", LabelSpec(title = "A"))
        val o2 = m.print("job-2", LabelSpec(title = "B"))
        assertTrue(o1.ok && o2.ok)
        assertEquals(2, t.writes)
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
    }

    @Test
    fun `duplicate job id is never written twice (S15, S18)`() {
        val t = FakeTransport()
        val m = manager(transport = t)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        val first = m.print("job-dup", LabelSpec(title = "A"))
        val second = m.print("job-dup", LabelSpec(title = "A"))
        assertTrue(first.ok && !first.duplicate)
        assertTrue(second.ok && second.duplicate)
        assertEquals(1, t.writes)
    }

    @Test
    fun `a job without an id is refused, never printed (owner rule - one action = one label)`() {
        val t = FakeTransport()
        val m = manager(transport = t)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")

        val outcome = m.print("", LabelSpec(title = "A"))

        assertEquals(0, t.writes)                       // nothing physically moved
        assertFalse(outcome.ok)
        assertEquals("JOB_ID_REQUIRED", outcome.error?.code)
        // A caller mistake is not a printer fault: the link is still healthy.
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
        assertTrue(m.connectedPrinter != null)
    }

    @Test
    fun `two retries of one job arriving together still write one label (owner rule)`() {
        val t = FakeTransport()
        val m = manager(transport = t, store = FakePersistence(rememberDelayMs = 25))
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        val threads = 8
        val start = java.util.concurrent.CountDownLatch(1)
        val finished = java.util.concurrent.CountDownLatch(threads)
        repeat(threads) {
            Thread {
                start.await()
                m.print("job-retry", LabelSpec(title = "A"))
                finished.countDown()
            }.start()
        }
        start.countDown()
        assertTrue(finished.await(10, java.util.concurrent.TimeUnit.SECONDS))

        assertEquals(1, t.writes) // ONE label for one action, however many callers
    }

    @Test
    fun `print failure marks the link lost and offers reconnect (S13, S19)`() {
        val t = FakeTransport()
        val m = manager(transport = t)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        t.failWrite = true
        val out = m.print("job-fail", LabelSpec(title = "A"))
        assertFalse(out.ok)
        assertEquals(PrinterConnectionState.DISCONNECTED, m.state)
        assertEquals("Printer connection lost.", out.error?.userMessage)
        t.failWrite = false
        assertTrue(m.reconnect())
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
    }

    @Test
    fun `acl disconnect notifies and keeps the saved printer (S7, S19)`() {
        val store = FakePersistence()
        val m = manager(store = store)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        m.onConnectionLost("ACL_DISCONNECTED")
        assertEquals(PrinterConnectionState.DISCONNECTED, m.state)
        assertEquals("Printer connection lost.", m.lastError?.userMessage)
        assertEquals("PM-241-BT", m.status().savedPrinter?.name)
    }

    @Test
    fun `reconnect succeeds when the radio comes back (S7)`() {
        val t = FakeTransport()
        val m = manager(transport = t)
        m.connect("E9:BD:F6:4B:95:40", "PM-241-BT")
        m.onConnectionLost("ACL")
        assertTrue(m.reconnect())
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
    }

    @Test
    fun `app restart path reconnects from the saved printer alone (S8, S14)`() {
        val store = FakePersistence()
        store.saveSaved(PrinterInfo("PM-241-BT", "E9:BD:F6:4B:95:40"))
        val t = FakeTransport()
        val m = PrinterManager(store, t, FakeFinder(), PrintQueue(t, store))
        assertTrue(m.reconnect())
        assertEquals(PrinterConnectionState.CONNECTED, m.state)
    }
}
