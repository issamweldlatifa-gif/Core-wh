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
 * RECEIVING HOME (device-side matching rebuild) — workflow contract tests.
 *
 * Counters come from the dispatched feed; RECEIVING never opens a scanner;
 * PRODUIT and CARTON have dedicated scanners; matching is on the device and
 * is STRICTLY separated (product scan cannot confirm a carton and vice
 * versa); mismatch confirms nothing; duplicate completion is rejected.
 */
class ReceivingHomeWorkflowTest {
    private val perms = setOf("receiving.view", "receiving.execute")

    private fun TestScope.workflow(backend: HomeBackend = HomeBackend()): ReceivingHomeWorkflow =
        ReceivingHomeWorkflow(backend, "worker", perms, this).also {
            it.updateAccess(perms, true); it.initialize(); runCurrent()
        }

    private fun scan(value: String, source: ScanSource = ScanSource.CAMERA, symbology: ScanSymbology = ScanSymbology.QR) =
        ScanResult(value, source, symbology)

    // ----------------------------- HOME ---------------------------------
    @Test fun `home loads with live product and carton counters`() = runTest {
        val flow = workflow()
        val state = flow.state.value
        assertEquals(HomeStep.HOME, state.step)
        assertEquals(1, state.home?.productCardsPending)
        assertEquals(1, state.home?.cartonCardsPending)
        // Lists enumerate what arrived (information only).
        assertEquals("SKU/A-01", state.home?.productList?.first()?.reference)
        assertEquals("CTN-001", state.home?.cartonList?.first()?.reference)
    }

    @Test fun `receiving does not arm the scanner until a lane is opened`() = runTest {
        val flow = workflow()
        assertFalse(flow.state.value.canScan, "HOME must never be a capture step")
        flow.openProduct(); runCurrent()
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertTrue(flow.state.value.canScan)
        flow.backToHome(); runCurrent()
        assertFalse(flow.state.value.canScan)
        flow.openCarton(); runCurrent()
        assertEquals(HomeStep.CARTON_SCAN, flow.state.value.step)
        assertTrue(flow.state.value.canScan)
    }

    // --------------------------- PRODUCT LANE ---------------------------
    @Test fun `product scan matches the product card on the device`() = runTest {
        val flow = workflow()
        flow.openProduct(); runCurrent()
        flow.scan(scan("sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(HomeStep.REVIEW_PRODUCT, flow.state.value.step)
        assertNotNull(flow.state.value.productReview)
        assertEquals("SKU/A-01", flow.state.value.productReview?.card?.sku)
    }

    @Test fun `product confirm sends one unit and decreases the counter`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("REF-ONLY", ScanSource.MANUAL)); runCurrent()
        assertEquals(HomeStep.REVIEW_PRODUCT, flow.state.value.step)
        flow.confirm(); runCurrent()
        assertTrue(backend.calls.contains("home-product"))
        // Card expected 2, received 1 -> still 1 pending.
        assertEquals(1, flow.state.value.home?.productCardsPending)
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
    }

    @Test fun `product confirm twice completes the card and removes it`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        repeat(2) {
            flow.openProduct(); runCurrent()
            flow.scan(scan("SKU/A-01", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
            flow.confirm(); runCurrent()
        }
        assertEquals(0, flow.state.value.home?.productCardsPending)
    }

    @Test fun `wrong product code is a mismatch and confirms nothing`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("SKU-UNKNOWN", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        // Back on the scanner, NOT in review; mismatch logged.
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertNull(flow.state.value.productReview)
        assertTrue(backend.calls.contains("home-mismatch"))
        assertEquals(1, flow.state.value.home?.productCardsPending)
    }

    @Test fun `product scanner cannot match a carton identifier`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        // A carton / tracking code read in the PRODUCT lane must NOT match.
        flow.scan(scan("CTN-001", ScanSource.CAMERA)); runCurrent()
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertNull(flow.state.value.productReview)
        flow.scan(scan("TRK-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
        assertNull(flow.state.value.productReview)
        // Carton untouched.
        assertEquals(1, flow.state.value.home?.cartonCardsPending)
    }

    // ---------------------------- CARTON LANE ---------------------------
    @Test fun `carton scan matches on carton id ref qr barcode or tracking`() = runTest {
        listOf("CTN-001", "REF-CTN-001", "QR-CTN-001", "BC-CTN-001", "TRK-001").forEach { code ->
            val flow = workflow()
            flow.openCarton(); runCurrent()
            flow.scan(scan(code, ScanSource.CAMERA)); runCurrent()
            assertEquals(HomeStep.REVIEW_CARTON, flow.state.value.step, "matching $code must open carton review")
            assertNotNull(flow.state.value.cartonReview)
        }
    }

    @Test fun `carton confirm completes the carton and decreases the counter`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("CTN-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
        flow.confirm(); runCurrent()
        assertTrue(backend.calls.contains("home-carton"))
        assertEquals(0, flow.state.value.home?.cartonCardsPending)
        assertEquals(HomeStep.CARTON_SCAN, flow.state.value.step)
    }

    @Test fun `carton scanner cannot match a product identifier`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("SKU/A-01", ScanSource.CAMERA)); runCurrent()
        assertEquals(HomeStep.CARTON_SCAN, flow.state.value.step)
        assertNull(flow.state.value.cartonReview)
        assertEquals(1, flow.state.value.home?.productCardsPending)
    }

    @Test fun `already received carton is rejected and not counted again`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("CTN-001")); runCurrent()
        flow.confirm(); runCurrent()
        // Scan the same carton again — device sees no pending carton card -> mismatch/reject.
        flow.scan(scan("CTN-001")); runCurrent()
        assertNull(flow.state.value.cartonReview)
        assertEquals(0, flow.state.value.home?.cartonCardsPending)
    }

    // ------------------------------ ACCESS ------------------------------
    @Test fun `worker without receiving permission cannot scan or confirm`() = runTest {
        val backend = HomeBackend()
        val flow = ReceivingHomeWorkflow(backend, "worker", emptySet(), this).also {
            it.updateAccess(emptySet(), true); it.initialize(); runCurrent()
        }
        flow.openProduct(); runCurrent()
        assertFalse(flow.state.value.authorized)
        assertFalse(flow.state.value.canScan)
    }

    @Test fun `offline worker cannot scan`() = runTest {
        val backend = HomeBackend()
        val flow = ReceivingHomeWorkflow(backend, "worker", perms, this).also {
            it.updateAccess(perms, false); it.initialize(); runCurrent()
        }
        flow.openProduct(); runCurrent()
        assertFalse(flow.state.value.canScan)
    }
}
