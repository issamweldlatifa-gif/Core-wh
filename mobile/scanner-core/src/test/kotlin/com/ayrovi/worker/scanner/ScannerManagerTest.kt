package com.ayrovi.worker.scanner

import kotlin.test.*

class ScannerManagerTest {
    @Test fun `sliding duplicate suppression holds for continuously visible label`() {
        val guard = ScanDecision(windowMs = 1500, debounceMs = 0)
        assertIs<ScanOutcome.Accepted>(guard.evaluate("SKU-01", 0))
        for (time in 500L..10_000L step 500) {
            assertEquals(RejectReason.DUPLICATE, assertIs<ScanOutcome.Rejected>(guard.evaluate("SKU-01", time)).reason)
        }
        assertIs<ScanOutcome.Accepted>(guard.evaluate("SKU-01", 12_000))
    }
    @Test fun `same SKU on next physical item requires explicit rearm or quiet window`() {
        var now = 1L
        val scanner = ScannerManager(clock = { now }, initiallyEnabled = true)
        assertNotNull(scanner.capture("SKU-01", ScanSource.CAMERA))
        assertNull(scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER))
        scanner.rearm()
        assertNotNull(scanner.capture("SKU-01", ScanSource.CAMERA))
        now += 2000
        assertNotNull(scanner.capture("SKU-01", ScanSource.CAMERA))
    }
    @Test fun `disabled and background inputs never reach workflow`() {
        val scanner = ScannerManager()
        assertNull(scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER))
        scanner.setEnabled(true)
        assertNotNull(scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER))
        scanner.setEnabled(false)
        assertNull(scanner.capture("SKU-02", ScanSource.EXTERNAL_SCANNER))
        assertEquals(ScannerStatus.DISABLED, scanner.state.value.status)
    }
    @Test fun `held hardware label remains suppressed across busy state`() {
        var now = 0L
        val scanner = ScannerManager(clock = { now }, initiallyEnabled = true)
        scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER)
        scanner.setEnabled(false)
        for (time in 1000L..5000L step 1000) { now = time; scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER) }
        scanner.setEnabled(true); now = 5100
        assertNull(scanner.capture("SKU-01", ScanSource.EXTERNAL_SCANNER))
        assertEquals(ScannerStatus.DUPLICATE, scanner.state.value.status)
    }
    @Test fun `input identity preserves case punctuation and unicode`() {
        val scanner = ScannerManager(initiallyEnabled = true)
        assertEquals("Sku/ä-01", scanner.capture("  Sku/ä-01\r\n", ScanSource.MANUAL)?.value)
        assertNotNull(scanner.capture("SKU/Ä-01", ScanSource.MANUAL))
    }
    @Test fun `empty oversized and embedded control input are invalid`() {
        val scanner = ScannerManager(initiallyEnabled = true)
        for (code in listOf(" ", "A\nB", "A\u0000B", "A".repeat(1025))) {
            assertNull(scanner.capture(code, ScanSource.MANUAL), code.take(12))
            assertEquals(ScannerStatus.INVALID, scanner.state.value.status)
        }
        assertNotNull(scanner.capture("A\u001dB", ScanSource.EXTERNAL_SCANNER), "GS1 separators are preserved")
    }
    @Test fun `camera QR barcode manual and hardware retain actual source`() {
        val scanner = ScannerManager(initiallyEnabled = true)
        assertEquals("QR", scanner.capture("QR-01", ScanSource.CAMERA, ScanSymbology.QR)?.scanType)
        assertEquals("BARCODE", scanner.capture("B-01", ScanSource.EXTERNAL_SCANNER)?.scanType)
        assertEquals("MANUAL", scanner.capture("M-01", ScanSource.MANUAL)?.scanType)
    }
    @Test fun `cancel timeout and unavailable states are explicit and emit no result`() {
        val scanner = ScannerManager(initiallyEnabled = true)
        scanner.beginScan(); scanner.timeout()
        assertEquals(ScannerStatus.TIMEOUT, scanner.state.value.status)
        assertNull(scanner.state.value.result)
        scanner.beginScan(); scanner.cancel()
        assertEquals(ScannerStatus.CANCELLED, scanner.state.value.status)
        scanner.unavailable("Profile not provisioned")
        assertEquals(ScannerStatus.UNAVAILABLE, scanner.state.value.status)
        assertEquals("Profile not provisioned", scanner.state.value.detail)
    }
    @Test fun `successful capture is not warehouse receipt success`() {
        val scanner = ScannerManager(initiallyEnabled = true)
        scanner.capture("SKU", ScanSource.MANUAL)
        assertEquals(ScannerStatus.CAPTURED, scanner.state.value.status)
        assertTrue(scanner.state.value.detail.contains("awaiting workflow validation"))
    }
}
