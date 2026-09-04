package com.ayrovi.worker.scanner

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ScanDecisionTest {
    @Test
    fun acceptsUniqueScansAndRejectsDuplicatesInWindow() {
        val d = ScanDecision(windowMs = 100_000, debounceMs = 0)
        assertIs<ScanOutcome.Accepted>(d.evaluate("AYROVI-RCV-0001", 1000))
        assertIs<ScanOutcome.Rejected>(d.evaluate("AYROVI-RCV-0001", 1200), "duplicate within window")
        assertIs<ScanOutcome.Accepted>(d.evaluate("AYROVI-RCV-0002", 1400), "different code accepted")
    }

    @Test
    fun debounceSuppressesHoldTrigger() {
        val d = ScanDecision(windowMs = 100_000, debounceMs = 500)
        assertIs<ScanOutcome.Accepted>(d.evaluate("ABC-1", 0))
        assertIs<ScanOutcome.Rejected>(d.evaluate("ABC-1", 100), "too soon (debounced)")
        assertIs<ScanOutcome.Accepted>(d.evaluate("ABC-2", 600), "after debounce, different code")
    }

    @Test
    fun emptyInputIsRejected() {
        val d = ScanDecision()
        assertIs<ScanOutcome.Rejected>(d.evaluate("   "))
    }

    @Test
    fun resetClearsHistory() {
        val d = ScanDecision(windowMs = 100_000, debounceMs = 0)
        assertIs<ScanOutcome.Accepted>(d.evaluate("SAME", 100))
        assertIs<ScanOutcome.Rejected>(d.evaluate("SAME", 200))
        d.reset()
        assertIs<ScanOutcome.Accepted>(d.evaluate("SAME", 300), "after reset same code accepted again")
    }
}

class OcrNormalizerTest {
    private val n = OcrNormalizer()

    @Test
    fun normalisesCaseWhitespaceAndGlyphs() {
        assertEquals("ABC-123 XYZ", n.normalise("  aBc-|23\nxyZ \t "))
    }

    @Test
    fun extractsStructuredCodeFromNoisySentence() {
        val sentence = "Carton reference AYROVI-RCV-0099 arrived damaged"
        val best = n.bestCandidate(sentence)
        assertTrue(best != null, "expected a candidate")
        assertEquals("AYROVI-RCV-0099", best!!.token)
        assertTrue(best.confidence >= 0.8)
    }

    @Test
    fun rejectsPureDigitsAsLowConfidenceCode() {
        val best = n.bestCandidate("12345")
        // Pure numbers score < 0.8 → not accepted blindly.
        assertNull(best, "pure digit runs must not be auto-accepted")
    }

    @Test
    fun noCandidateForEmptyOrNoiseText() {
        assertNull(n.bestCandidate(""))
        assertNull(n.bestCandidate("???"))
    }
}

class OfflineQueueTest {
    @Test
    fun enqueueDedupeMarkSyncRoundTrip() {
        val q = OfflineQueue()
        val op = QueuedOperation(
            operationId = "op-1",
            workerId = "w1",
            deviceId = "d1",
            stationId = "s1",
            endpoint = "/v1/receiving/sessions/x/scan-carton",
            bodyJson = """{"code":"A1"}""",
            localSequence = 1,
            createdAtEpochMs = 1000,
        )
        assertEquals(EnqueueResult.OK, q.enqueue(op))
        assertEquals(EnqueueResult.DUPLICATE, q.enqueue(op.copy()), "same operationId never duplicates")
        assertEquals(1, q.size())

        q.markSyncing("op-1")
        assertTrue(q.pending().isEmpty())
        q.markFailed("op-1")
        assertTrue(q.pending().isEmpty(), "failed stays for retry decision")
        q.markSynced("op-1")
    }

    @Test
    fun serializationRoundTripKeepsEnvelope() {
        val q = OfflineQueue()
        q.enqueue(
            QueuedOperation(
                operationId = "op-9",
                workerId = "w2",
                deviceId = "d2",
                endpoint = "/v1/putaway/scan-carton",
                bodyJson = "{}",
                localSequence = 3,
                createdAtEpochMs = 42,
            ),
        )
        val blob = OfflineQueue.toJson(q)
        val restored = OfflineQueue.fromJson(blob)
        assertEquals(1, restored.size())
        val item = restored.pending().single()
        assertEquals("op-9", item.operationId)
        assertEquals(3, item.localSequence)
    }

    @Test
    fun queueRespectsCapacity() {
        val q = OfflineQueue(maxSize = 2)
        repeat(2) { i ->
            assertEquals(
                EnqueueResult.OK,
                q.enqueue(
                    QueuedOperation(
                        operationId = "op-$i",
                        workerId = "w",
                        deviceId = "d",
                        endpoint = "/v1/x",
                        bodyJson = "{}",
                        localSequence = i.toLong(),
                        createdAtEpochMs = i.toLong(),
                    ),
                ),
            )
        }
        assertEquals(EnqueueResult.FULL, q.enqueue(q.pending().first().copy(operationId = "op-99")))
    }
}
