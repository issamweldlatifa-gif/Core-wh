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
 * PRODUIT / CARTON lane selection (the two real workflow entries) and lane
 * isolation: PRODUCT scans only touch PRODUCT cards, CARTON scans only CARTON
 * cards — the card sets are never merged.
 */
class ReceivingModeTest {
    private val permissions = setOf("receiving.view", "receiving.execute")

    private fun TestScope.create(backend: ReceivingBackend, journal: MemoryJournal = MemoryJournal()) =
        ReceivingWorkflow(backend, journal, "worker", permissions, this).also {
            it.updateAccess(permissions, true); it.initialize(); runCurrent()
        }

    private fun TestScope.open(flow: ReceivingWorkflow) { flow.openArrival("WAR-001"); runCurrent() }
    private fun TestScope.toProduct(flow: ReceivingWorkflow) { flow.selectMode(ReceivingMode.PRODUCTS); runCurrent() }
    private fun TestScope.toCarton(flow: ReceivingWorkflow) { flow.selectMode(ReceivingMode.CARTONS); runCurrent() }

    @Test fun `carton lane loops to the next carton without forcing the product lane`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertTrue(flow.state.value.canScan)
        assertEquals(1, flow.state.value.session!!.tally.receivedCartons)
        assertEquals(0, flow.state.value.session!!.tally.receivedUnits)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `produit lane loops to the next product without touching carton state`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)
        assertEquals(0, flow.state.value.session!!.tally.receivedCartons)
        assertEquals(0, backend.cartonCalls)
    }

    @Test fun `one tap selects the lane and scanning starts immediately`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        toProduct(flow)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertTrue(flow.state.value.canScan)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        flow.confirmCard(); runCurrent()
        assertEquals(1, backend.productCalls)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)
    }

    @Test fun `a carton in the produit lane never confirms a product and vice versa`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow) // CARTONS
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent() // a PRODUCT identifier
        assertEquals("CARTON", backend.mismatchCardType)
        assertEquals(0, backend.productCalls)
        toProduct(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent() // a CARTON identifier
        assertEquals(2, backend.mismatchCalls)
        assertEquals("PRODUCT", backend.mismatchCardType)
        assertEquals(0, backend.cartonCalls)
    }

    @Test fun `unsubmitted review is discarded by a lane switch without any write`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL)); runCurrent()
        toProduct(flow)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertNull(flow.state.value.carton)
        assertEquals(0, backend.cartonCalls)
        // The product lane matches product cards only.
        flow.scan(ScanResult("Sku/a-01", ScanSource.MANUAL)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        toCarton(flow)
        assertNull(flow.state.value.product)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `rapid lane taps during a scan do not enqueue a transition or a write`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL))
        repeat(20) { flow.selectMode(ReceivingMode.PRODUCTS) }
        runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step)
        assertEquals(0, backend.cartonCalls)
    }

    @Test fun `lane selection cannot dismiss an uncertain write or another worker hold`() = runTest {
        for (worker in listOf("worker", "other-worker")) {
            val journal = MemoryJournal().apply { value = PendingMutation("held", worker, MutationKind.CONFIRM_CARTON, "session", createdAt = 1) }
            val flow = create(ReceivingBackend(), journal)
            flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
            assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
            assertEquals(ReceivingStep.RECONCILE, flow.state.value.step)
            assertNotNull(journal.read())
        }
    }

    @Test fun `offline revoked paused and closed states cannot be bypassed by lane selection`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.updateAccess(permissions, false); toProduct(flow)
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        flow.updateAccess(setOf("receiving.view"), true); toProduct(flow)
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        flow.updateAccess(permissions, true)
        flow.pause(); runCurrent()
        toProduct(flow)
        assertEquals(ReceivingStep.PAUSED, flow.state.value.step)
        backend.current = backend.current.copy(status = "COMPLETED")
        flow.refresh(); runCurrent(); toProduct(flow)
        assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `read failure during a lane change leaves the previous context intact`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        backend.readFailure = TransportFailure(false)
        toProduct(flow)
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `repeated already-received carton stays rejected on every lane`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(1, backend.cartonCalls)
        // Same carton again: the refreshed cards show RECEIVED -> local reject.
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals("CARTON ALREADY RECEIVED", flow.state.value.message!!.title)
        assertEquals(1, backend.cartonCalls)
        assertEquals(1, flow.state.value.session!!.tally.receivedCartons)
    }

    @Test fun `ambiguous tracking survives a lane switch as a local warning, never a write`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(cartonCards = current.cartonCards + current.cartonCards[0].copy(
                id = "carton-2", externalCartonId = "CTN-002", cartonNumber = 2, totalCartons = 2,
                identifiers = listOf("CTN-002")))
        }
        val flow = create(backend); open(flow)
        flow.scan(ScanResult("TRK-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        toProduct(flow)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, backend.mismatchCalls)
    }
}
