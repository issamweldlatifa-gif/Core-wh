package com.ayrovi.worker.printer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PrintQueueTest {

    private class TrackedTransport : PrinterTransport {
        val order = mutableListOf<Int>()
        var connectedFlag = true
        override val connected: Boolean get() = connectedFlag
        override fun connect(address: String) { connectedFlag = true }
        override fun write(data: ByteArray) {
            val id = data.toString(Charsets.US_ASCII).toInt()
            order.add(id)
            // Simulated slow link: a second submit CANNOT interleave.
            Thread.sleep(20)
        }
        override fun disconnect() { connectedFlag = false }
    }

    private class Store : PrinterPersistence {
        val jobs = LinkedHashSet<String>()
        override fun loadSaved(): PrinterInfo? = null
        override fun saveSaved(printer: PrinterInfo) {}
        override fun clearSaved() {}
        override fun seenJob(jobId: String): Boolean = jobs.contains(jobId)
        override fun rememberJob(jobId: String) { jobs.add(jobId) }
        override fun bridgeEnabled(): Boolean = false
        override fun setBridgeEnabled(enabled: Boolean) {}
    }

    @Test
    fun `jobs execute strictly one at a time in submission order (S12)`() {
        val t = TrackedTransport()
        val q = PrintQueue(t, Store())
        val results = mutableListOf<PrintOutcome>()
        val resultsLock = Any()
        for (i in 1..5) {
            q.submit("j$i", i.toString().toByteArray()) { o -> synchronized(resultsLock) { results.add(o) } }
        }
        q.awaitIdle()
        assertEquals(listOf(1, 2, 3, 4, 5), t.order)
        assertEquals(5, results.size)
        assertTrue(results.all { it.ok })
    }

    @Test
    fun `a repeated job id is short-circuited without a write (S15)`() {
        val t = TrackedTransport()
        val store = Store()
        val q = PrintQueue(t, store)
        q.submit("dup", "7".toByteArray()) { }
        q.awaitIdle()
        var duplicate = false
        q.submit("dup", "7".toByteArray()) { o -> duplicate = o.duplicate && o.ok }
        q.awaitIdle()
        assertEquals(listOf(7), t.order)
        assertTrue(duplicate)
    }

    @Test
    fun `write failure surfaces the transport error once (S13)`() {
        val t = TrackedTransport()
        val q = PrintQueue(t, Store())
        t.connectedFlag = true
        var error: PrinterError? = null
        val broken = PrintQueue(object : PrinterTransport {
            override val connected get() = true
            override fun connect(address: String) {}
            override fun write(data: ByteArray) { throw PrinterException(PrinterError("LINK_LOST", "Printer connection lost.")) }
            override fun disconnect() {}
        }, Store())
        broken.submit("boom", ByteArray(1)) { o -> error = o.error }
        broken.awaitIdle()
        assertEquals("LINK_LOST", error?.code)
        assertEquals(0, t.order.size)
    }
}
