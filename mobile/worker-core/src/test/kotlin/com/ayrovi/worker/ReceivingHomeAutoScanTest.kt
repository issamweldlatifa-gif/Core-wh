@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import com.ayrovi.worker.scanner.ScanSymbology
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/**
 * UX RESTRUCTURE — the HOME "QR CODE" tool (AUTO scan) contract tests.
 *
 * The AUTO scanner opens DIRECTLY from Home (no lane picker) and must behave
 * EXACTLY like the dedicated lanes: a product read follows the PRODUCT path,
 * a carton read follows the CARTON path, success auto-approves, and a read
 * that matches nothing is NOT MATCHED + logged ONCE (§10/§11 unchanged).
 */
class ReceivingHomeAutoScanTest {
    private val perms = setOf("receiving.view", "receiving.execute")

    private fun TestScope.workflow(backend: HomeBackend = HomeBackend()): ReceivingHomeWorkflow =
        ReceivingHomeWorkflow(backend, "worker", perms, this).also {
            it.updateAccess(perms, true); it.initialize(); runCurrent()
        }

    private fun scan(value: String, source: ScanSource = ScanSource.CAMERA, symbology: ScanSymbology = ScanSymbology.QR) =
        ScanResult(value, source, symbology)

    // ------------------------------ ENTRY -------------------------------
    @Test fun `qr tool opens the auto scanner directly and arms capture`() = runTest {
        val flow = workflow()
        assertFalse(flow.state.value.canScan, "HOME never captures")
        flow.openAutoScan(); runCurrent()
        assertEquals(HomeStep.AUTO_SCAN, flow.state.value.step)
        assertTrue(flow.state.value.canScan, "the tool scanner must be armed immediately")
        flow.backToHome(); runCurrent()
        assertEquals(HomeStep.HOME, flow.state.value.step)
        assertFalse(flow.state.value.canScan)
    }

    // --------------------------- PRODUCT READ ---------------------------
    @Test fun `auto scan of a product QR follows the existing product success flow`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openAutoScan(); runCurrent()
        flow.scan(scan("sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        // Same confirm endpoint + same verdict as the PRODUCT lane.
        assertTrue(backend.calls.contains("home-product"))
        assertEquals(MessageTone.SUCCESS, flow.state.value.message?.tone)
        assertEquals("PRODUCT RECEIVED", flow.state.value.message?.title)
        assertEquals(HomeStep.AUTO_SCAN, flow.state.value.step, "the tool re-arms for the next read")
        assertEquals(1, backend.productCards.first().received)
    }

    @Test fun `auto scan of an already-scanned unit is rejected like the product lane`() = runTest {
        // Unit-distinct identifiers (serials) are one-scan-only; model codes
        // (SKU/reference) keep counting — the EXISTING rule, unchanged.
        val backend = HomeBackend()
        backend.productCards = mutableListOf(
            backend.productCards[0].copy(identifiers = listOf("SKU/A-01", "REF-ONLY", "UNIT-P001")),
        )
        val flow = workflow(backend)
        flow.openAutoScan(); runCurrent()
        flow.scan(scan("UNIT-P001")); runCurrent() // the physical unit is received
        assertEquals("PRODUCT RECEIVED", flow.state.value.message?.title)
        flow.scan(scan("UNIT-P001")); runCurrent() // same unit again
        assertEquals("ALREADY SCANNED", flow.state.value.message?.title)
        assertEquals(MessageTone.WARNING, flow.state.value.message?.tone)
        assertEquals(1, backend.calls.count { it == "home-product" }, "the backend is never called twice for one unit")
    }

    // --------------------------- CARTON READ ----------------------------
    @Test fun `auto scan of a carton QR follows the existing carton success flow`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openAutoScan(); runCurrent()
        flow.scan(scan("QR-CTN-001", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        // Same confirm endpoint + same verdict as the CARTON lane.
        assertTrue(backend.calls.contains("home-carton"))
        assertEquals(MessageTone.SUCCESS, flow.state.value.message?.tone)
        assertEquals("CARTON RECEIVED", flow.state.value.message?.title)
        assertEquals("RECEIVED", backend.cartonCards.first().status)
    }

    @Test fun `auto scan of a tracking number matches the carton like the carton lane`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openAutoScan(); runCurrent()
        flow.scan(scan("trk-001")); runCurrent()
        assertTrue(backend.calls.contains("home-carton"))
        assertEquals(MessageTone.SUCCESS, flow.state.value.message?.tone)
    }

    // ------------------------------ MISMATCH ----------------------------
    @Test fun `auto scan of an unknown code is NOT MATCHED and logged exactly once`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openAutoScan(); runCurrent()
        flow.scan(scan("UNKNOWN-999")); runCurrent()
        assertEquals("NOT MATCHED", flow.state.value.message?.title)
        assertEquals(MessageTone.ERROR, flow.state.value.message?.tone)
        assertTrue(
            flow.state.value.message?.detail?.contains("The failure was logged.") == true,
            "the existing error contract text must stay",
        )
        assertEquals("UNKNOWN-999", flow.state.value.message?.scanned)
        assertEquals(1, backend.calls.count { it == "home-mismatch" }, "one read = one failure log, never two")
    }

    // ------------------- EXISTING LANES KEEP THEIR TEXT ------------------
    @Test fun `product lane mismatch keeps its exact existing message`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("UNKNOWN-999")); runCurrent()
        assertEquals("NOT MATCHED", flow.state.value.message?.title)
        assertEquals("No product card matches this code. The failure was logged.", flow.state.value.message?.detail)
    }

    @Test fun `carton lane mismatch keeps its exact existing message`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("UNKNOWN-999")); runCurrent()
        assertEquals("NOT MATCHED", flow.state.value.message?.title)
        assertEquals("No carton card matches this code. The failure was logged.", flow.state.value.message?.detail)
    }
}
