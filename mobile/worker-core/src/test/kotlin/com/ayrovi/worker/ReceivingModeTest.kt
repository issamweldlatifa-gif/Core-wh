@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ReceivingModeTest {
    private val permissions = setOf("receiving.view", "receiving.execute")
    private fun TestScope.create(backend: ReceivingBackend, journal: MemoryJournal = MemoryJournal()) =
        ReceivingWorkflow(backend, journal, "worker", permissions, this).also {
            it.updateAccess(permissions, true); it.initialize(); runCurrent()
        }
    private fun TestScope.open(flow: ReceivingWorkflow) { flow.openArrival("WAR-001"); runCurrent() }
    private fun TestScope.carton(flow: ReceivingWorkflow) {
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCarton(); runCurrent()
    }
    private fun TestScope.toProduct(flow: ReceivingWorkflow) {
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        flow.scan(ScanResult("RCN-000001", ScanSource.MANUAL)); runCurrent()
    }

    @Test fun `carton mode loops to next carton without forcing tote or product receipt`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertTrue(flow.state.value.canScan)
        assertEquals("CTN-001", flow.state.value.sourceCarton!!.code)
        assertNull(flow.state.value.carton, "preview is separate from confirmed source")
        assertEquals(1, flow.state.value.session!!.tally.receivedCartons)
        assertEquals(0, flow.state.value.session!!.tally.receivedUnits)
        assertEquals(0, backend.articleCalls)
        assertTrue(backend.calls.none { it.startsWith("container:") })
    }
    @Test fun `choosing a mode before arrival makes no stock request`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend)
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingMode.PRODUCTS, flow.state.value.mode)
        assertEquals(ReceivingStep.ARRIVAL, flow.state.value.step)
        assertEquals(listOf("arrivals"), backend.calls)
    }
    @Test fun `product mode cannot bypass source carton verification`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertNull(flow.state.value.sourceCarton)
        assertEquals("PRODUCT MODE · SOURCE REQUIRED", flow.state.value.message!!.title)
        assertEquals(0, backend.receiveCartonCalls)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `one tap selects products then verified tote and exact SKU use existing article API`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        toProduct(flow)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        flow.scan(ScanResult("Sku/a-01", ScanSource.MANUAL)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        assertEquals(0, backend.articleCalls)
        flow.confirmProduct(); runCurrent()
        assertEquals(1, backend.receiveCartonCalls)
        assertEquals(1, backend.articleCalls)
        assertEquals("CTN-001", backend.sourceCarton)
        assertEquals("RCN-000001", backend.receivedTote)
    }
    @Test fun `mode change retains an identified carton but never treats it as received`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL)); runCurrent()
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.CONFIRM_CARTON, flow.state.value.step)
        assertNotNull(flow.state.value.carton)
        assertNull(flow.state.value.sourceCarton)
        assertEquals(0, backend.receiveCartonCalls)
        flow.confirmCarton(); runCurrent()
        assertEquals(1, backend.receiveCartonCalls)
        assertEquals(ReceivingStep.TOTE, flow.state.value.step)
    }
    @Test fun `switching away from unsubmitted product review never submits it`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA)); runCurrent()
        flow.setQuantity("999")
        flow.selectMode(ReceivingMode.CARTONS); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertNull(flow.state.value.product)
        assertEquals(0, backend.articleCalls)
        assertEquals(1, backend.receiveCartonCalls)
    }
    @Test fun `tote is revalidated when returning to product mode`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow); toProduct(flow)
        flow.selectMode(ReceivingMode.CARTONS); runCurrent()
        backend.tote = backend.tote.copy(status = "CLOSED")
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.TOTE, flow.state.value.step)
        assertNull(flow.state.value.tote)
        assertEquals("TOTE CANNOT BE USED", flow.state.value.message!!.title)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `removed source event cannot be inferred from aggregate count during mode change`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        backend.current = backend.current.copy(receivedCartonEvents = emptyList())
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertNull(flow.state.value.sourceCarton)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `a rejected new carton cannot fall back to an older source when selecting products`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        backend.wrongShipment = true
        flow.scan(ScanResult("CTN-OTHER", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertNull(flow.state.value.sourceCarton)
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertNull(flow.state.value.sourceCarton)
        assertEquals(0, backend.articleCalls)
        assertEquals(1, backend.receiveCartonCalls)
    }
    @Test fun `rapid mode taps during a scan do not enqueue a transition`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL))
        repeat(20) { flow.selectMode(ReceivingMode.PRODUCTS) }
        runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.CONFIRM_CARTON, flow.state.value.step)
        assertEquals(1, backend.calls.count { it == "scan-carton" })
    }
    @Test fun `mode changes cannot dismiss confirmed receipt acknowledgement`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal()
        val flow = create(backend, journal); open(flow); carton(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.MANUAL)); runCurrent()
        flow.confirmProduct(); runCurrent()
        val marker = journal.read()
        flow.selectMode(ReceivingMode.CARTONS); runCurrent()
        assertEquals(ReceivingMode.PRODUCTS, flow.state.value.mode)
        assertEquals(marker, journal.read())
        assertFalse(flow.state.value.canSelectMode)
        assertEquals(ReceivingStep.RESULT, flow.state.value.step)
    }
    @Test fun `mode changes cannot dismiss uncertain write or another worker hold`() = runTest {
        for (worker in listOf("worker", "other-worker")) {
            val journal = MemoryJournal().apply { value = PendingMutation("held", worker, MutationKind.RECEIVE_ARTICLE, "session", createdAt = 1) }
            val flow = create(ReceivingBackend(), journal)
            flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
            assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
            assertEquals(ReceivingStep.RECONCILE, flow.state.value.step)
            assertNotNull(journal.read())
        }
    }
    @Test fun `offline revoked paused and closed states cannot be bypassed by mode selection`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow)
        flow.updateAccess(permissions, false); flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        flow.updateAccess(setOf("receiving.view"), true); flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        flow.updateAccess(permissions, true); flow.pause(); runCurrent()
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.PAUSED, flow.state.value.step)
        backend.current = backend.current.copy(status = "COMPLETED")
        flow.refresh(); runCurrent(); flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `read failure during a mode change leaves the previous context intact`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        backend.readFailure = TransportFailure(false)
        flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals("CTN-001", flow.state.value.sourceCarton!!.code)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `repeated carton is selected without double receipt`() = runTest {
        val backend = ReceivingBackend(); val flow = create(backend); open(flow); carton(flow)
        carton(flow)
        assertEquals(1, backend.receiveCartonCalls)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals(1, flow.state.value.session!!.tally.receivedCartons)
    }
}
