package com.ayrovi.worker.scanner

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ScannerCoreTest {
    @Test fun duplicateReadsAreSuppressed() {
        val d = ScanDeduplicator(900)
        val first = d.decide(ScanCandidate("ABC123", ScanSource.BARCODE, 1000))
        val second = d.decide(ScanCandidate("abc123", ScanSource.BARCODE, 1200))
        assertTrue(first is ScanDecision.Accepted)
        assertTrue(second is ScanDecision.Duplicate)
    }

    @Test fun ocrProducesNormalizedCandidates() {
        assertEquals(listOf("SKU123", "BIN-04"), OcrNormalizer.candidates("sku123\nBIN-04"))
    }

    @Test fun failedSyncRemainsQueuedAndSuccessfulSyncRemoves() {
        val queue = InMemoryOfflineOperationQueue()
        queue.enqueue(PendingOperation(id = "1", endpoint = "/scan", payload = "{}", createdAtEpochMs = 1))
        val failed = OfflineSyncEngine(queue).sync { Result.failure<String>(IllegalStateException("offline")) }
        assertEquals(0, failed.succeeded)
        assertEquals(1, failed.remaining)
        val success = OfflineSyncEngine(queue).sync { Result.success("ok") }
        assertEquals(1, success.succeeded)
        assertEquals(0, success.remaining)
    }
}
