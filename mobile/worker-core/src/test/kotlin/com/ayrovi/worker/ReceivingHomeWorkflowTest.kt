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
    // AUTO-APPROVAL: a valid scan verifies + approves with no Confirm press,
    // then returns the lane to the scanner ready for the next product.
    @Test fun `product scan auto-approves and re-arms the scanner`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        // Approved on the backend without any further worker action.
        assertTrue(backend.calls.contains("home-product"))
        // Back on the scanner, review cleared -> next product can be scanned.
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertNull(flow.state.value.productReview)
        assertTrue(flow.state.value.canScan)
    }

    @Test fun `product scan sends one unit and decreases the counter`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("REF-ONLY", ScanSource.MANUAL)); runCurrent()
        assertTrue(backend.calls.contains("home-product"))
        // Card expected 2, received 1 -> still 1 pending.
        assertEquals(1, flow.state.value.home?.productCardsPending)
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
    }

    @Test fun `scanning twice completes the card and removes it`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        repeat(2) {
            flow.openProduct(); runCurrent()
            flow.scan(scan("SKU/A-01", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
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
            // Auto-approved: the lane returns to its scanner with the carton recorded.
            assertEquals(HomeStep.CARTON_SCAN, flow.state.value.step, "matching $code must auto-approve")
            assertEquals(0, flow.state.value.home?.cartonCardsPending, "$code must be received")
        }
    }

    @Test fun `carton scan auto-completes the carton and decreases the counter`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("CTN-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
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
        // Scan the same carton again — device sees no pending carton card -> mismatch/reject.
        flow.scan(scan("CTN-001")); runCurrent()
        assertNull(flow.state.value.cartonReview)
        assertEquals(0, flow.state.value.home?.cartonCardsPending)
    }

    @Test fun `approval without a returned feed re-pulls home so the completed card leaves the queue`() = runTest {
        // A gateway that completes the carton on the backend but returns NO
        // home payload with the verdict (older/partial contract). The workflow
        // must still re-pull the feed itself — a completed card can never be
        // left visibly pending on Home (stale-notification regression).
        val inner = HomeBackend()
        val gateway = object : ReceivingGateway by inner {
            override suspend fun homeConfirmCarton(
                identifier: String, identifierType: String, operationId: String, source: String, startedAt: String?,
            ): HomeScanResult {
                val result = inner.homeConfirmCarton(identifier, identifierType, operationId, source, startedAt)
                return result.copy(home = null) // simulate a verdict without the refreshed feed
            }
        }
        val flow = ReceivingHomeWorkflow(gateway, "worker", perms, this).also {
            it.updateAccess(perms, true); it.initialize(); runCurrent()
        }
        assertEquals(1, flow.state.value.home?.cartonCardsPending)
        flow.openCarton(); runCurrent()
        flow.scan(scan("CTN-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
        assertEquals(0, flow.state.value.home?.cartonCardsPending, "the re-pulled feed reflects completion")
    }

    // ------------------- AUTO APPROVAL (TEST E / F) ---------------------
    // SCAN -> VERIFY -> AUTO APPROVE -> NEXT, with no Confirm step.

    @Test fun `TEST E - no confirm is ever required after a valid scan`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("SKU/A-01")); runCurrent()
        // canConfirm must never be true: there is no button to enable.
        assertFalse(flow.state.value.canConfirm, "auto-approval leaves no pending confirmation")
        assertTrue(backend.calls.contains("home-product"))
    }

    @Test fun `TEST E - the scanner stays ready for the next product`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        val before = flow.state.value.scanEpoch
        flow.scan(scan("SKU/A-01")); runCurrent()
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertTrue(flow.state.value.canScan, "scanner must re-arm automatically")
        assertTrue(flow.state.value.scanEpoch > before, "scan epoch bumps so the capture host re-arms")
    }

    @Test fun `TEST F - a scan error approves nothing and keeps the same product`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        val pendingBefore = flow.state.value.home?.productCardsPending
        flow.scan(scan("NOT-A-REAL-CODE")); runCurrent()
        // No approval call, nothing counted, worker stays in the scanner.
        assertFalse(backend.calls.contains("home-product"))
        assertEquals(pendingBefore, flow.state.value.home?.productCardsPending)
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
        assertTrue(flow.state.value.canScan, "worker can immediately rescan the same product")
    }

    @Test fun `TEST F - an empty scan is not approved`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openProduct(); runCurrent()
        flow.scan(scan("")); runCurrent()
        assertFalse(backend.calls.contains("home-product"))
        assertEquals(HomeStep.PRODUCT_SCAN, flow.state.value.step)
    }

    @Test fun `an already complete card is not approved twice`() = runTest {
        val backend = HomeBackend()
        val flow = workflow(backend)
        flow.openCarton(); runCurrent()
        flow.scan(scan("CTN-001")); runCurrent()
        val callsAfterFirst = backend.calls.count { it == "home-carton" }
        flow.scan(scan("CTN-001")); runCurrent()
        assertEquals(callsAfterFirst, backend.calls.count { it == "home-carton" },
            "a completed carton must not be sent for approval again")
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
