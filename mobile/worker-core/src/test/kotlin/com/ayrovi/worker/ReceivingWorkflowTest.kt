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
 * Card-based receiving (device-side matching) — workflow contract tests.
 *
 * PRODUCT (PRODUIT) lane: QR / barcode / OCR-SKU / OCR-ref → MATCH · wrong id →
 * MISMATCH (logged) · completed card → rejected
 * CARTON lane: carton id / QR / barcode / ref / tracking → MATCH · wrong →
 * MISMATCH (logged) · already received → rejected · ambiguous tracking
 * both lanes: idempotent confirms · journal stop markers · permissions
 */
class ReceivingWorkflowTest {
    private val workerPermissions = setOf("receiving.view", "receiving.execute")

    private fun TestScope.workflow(
        backend: ReceivingBackend, journal: MemoryJournal = MemoryJournal(),
        permissions: Set<String> = workerPermissions,
    ): ReceivingWorkflow =
        ReceivingWorkflow(backend, journal, "worker", permissions, this).also {
            it.updateAccess(permissions, true); it.initialize(); runCurrent()
        }

    private fun TestScope.open(flow: ReceivingWorkflow) { flow.openArrival("WAR-001"); runCurrent() }
    private fun TestScope.toProduct(flow: ReceivingWorkflow) { flow.selectMode(ReceivingMode.PRODUCTS); runCurrent() }
    private fun TestScope.toCarton(flow: ReceivingWorkflow) { flow.selectMode(ReceivingMode.CARTONS); runCurrent() }

    // ============================ ARRIVAL GATE ============================
    @Test fun `arrival queue is real gateway data`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend)
        assertEquals("WAR-001", flow.state.value.arrivals.single().code)
        assertEquals(listOf("arrivals"), backend.calls)
    }

    @Test fun `war arrival scan keeps the backend path and enters the carton lane by default`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend)
        flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertTrue(backend.calls.contains("active:WAR-001"))
        assertEquals(1, backend.startCalls)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
    }

    @Test fun `non arrival scan at the ARRIVAL gate never reaches the arrival endpoint`() = runTest {
        listOf("CTN-001", "Sku/a-01", "TRK-001", "CUST-0091").forEach { scanned ->
            val backend = ReceivingBackend(); val flow = workflow(backend)
            flow.scan(ScanResult(scanned, ScanSource.EXTERNAL_SCANNER)); runCurrent()
            val message = flow.state.value.message
            assertEquals("NOT AN ARRIVAL CODE", message!!.title)
            assertEquals(scanned, message.scanned)
            assertEquals("AYROVI arrival code", message.expected)
            assertEquals(ReceivingStep.ARRIVAL, flow.state.value.step)
            assertTrue(backend.calls.none { it.startsWith("active:") || it == "start" })
        }
    }

    @Test fun `unknown arrival is an operational redirect not a raw lookup error`() = runTest {
        val backend = ReceivingBackend().apply { activeFailure = WorkerRepository.ApiException(404, "Expected arrival not found.") }
        val flow = workflow(backend)
        flow.scan(ScanResult("WAR-UNKNOWN", ScanSource.MANUAL)); runCurrent()
        assertEquals("ARRIVAL NOT FOUND", flow.state.value.message!!.title)
        assertEquals("WAR-UNKNOWN", flow.state.value.message!!.scanned)
        assertEquals(0, backend.startCalls)
    }

    @Test fun `queue selection opens the arrival through the same domain path`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend)
        flow.openArrival(flow.state.value.arrivals.single().code ?: error("queue code")); runCurrent()
        assertEquals(1, backend.startCalls)
        assertNotNull(flow.state.value.session)
    }

    @Test fun `existing active session is recovered instead of starting again`() = runTest {
        val backend = ReceivingBackend().apply { active = current }; val flow = workflow(backend); open(flow)
        assertEquals(0, backend.startCalls)
        assertEquals("session", flow.state.value.session!!.id)
    }

    // ============================ PRODUIT LANE ============================
    @Test fun `product qr scan matches the product card on device and waits for explicit confirm`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        assertEquals(2, flow.state.value.product!!.card.expected)
        assertEquals("A long test product name for a physical unit", flow.state.value.product!!.card.productName)
        assertEquals(0, backend.productCalls)
        assertEquals(0, backend.mismatchCalls)
    }

    @Test fun `barcode and ocr scans confirm with the right identifier type`() = runTest {
        // Barcode (external scanner symbology).
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals("BARCODE", backend.productScanType)
        assertEquals("EXTERNAL_SCANNER", backend.productSource)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)

        // OCR-confirmed reading (existing OCR pipeline, tagged OCR).
        val backend2 = ReceivingBackend(); val flow2 = workflow(backend2); open(flow2); toProduct(flow2)
        flow2.scan(ScanResult("Sku/a-01", ScanSource.OCR)); runCurrent()
        flow2.confirmCard(); runCurrent()
        assertEquals("OCR", backend2.productScanType)
        assertEquals(1, backend2.productCalls)
    }

    @Test fun `ocr reference matches the product card (reference is a first-class identifier)`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("ref-only", ScanSource.OCR)); runCurrent() // case-insensitive vs REF-ONLY
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        flow.confirmCard(); runCurrent()
        assertEquals("OCR", backend.productScanType)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)
    }

    @Test fun `confirm product sends one unit and the server payload drives state`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(1, backend.productCalls)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertNull(flow.state.value.product)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)
        assertEquals(1, flow.state.value.session!!.productCards.single().received)
        assertEquals(1, flow.state.value.session!!.productCards.single().remaining)
    }

    @Test fun `wrong product identifier is a device mismatch: logged, never confirmed`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("SKU-NOPE", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertEquals("NOT MATCHED", flow.state.value.message!!.title)
        assertEquals("SKU-NOPE", flow.state.value.message!!.scanned)
        assertEquals(1, backend.mismatchCalls)
        assertEquals("PRODUCT", backend.mismatchCardType)
        assertEquals("BARCODE", backend.mismatchScanType)
        assertEquals(0, backend.productCalls)
        assertEquals(0, flow.state.value.session!!.tally.receivedUnits)
    }

    @Test fun `completed product card is rejected locally with no write at all`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(productCards = current.productCards.map { it.copy(received = 2, remaining = 0, status = "RECEIVED") })
        }
        val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals("CARD ALREADY COMPLETE", flow.state.value.message!!.title)
        assertEquals(0, backend.productCalls)
        assertEquals(0, backend.mismatchCalls)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
    }

    @Test fun `rapid scans and double confirm never queue extra receipts`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        repeat(20) { flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)) }
        runCurrent()
        assertEquals(ReceivingStep.REVIEW_PRODUCT, flow.state.value.step)
        assertEquals(0, flow.state.value.session!!.tally.receivedUnits)
        repeat(20) { flow.confirmCard() }; runCurrent()
        assertEquals(1, backend.productCalls)
        assertEquals(1, flow.state.value.session!!.tally.receivedUnits)
    }

    // ============================ CARTON LANE ============================
    @Test fun `carton qr scan matches the carton card on device and waits for explicit confirm`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("QR-CTN-001", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step)
        assertEquals("CTN-001", flow.state.value.carton!!.card.externalCartonId)
        assertEquals("QR CODE", flow.state.value.carton!!.matchedOn)
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, backend.mismatchCalls)
    }

    @Test fun `carton barcode manual reference and lowercase external id all match`() = runTest {
        val scans = listOf(
            ScanResult("BC-CTN-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.BARCODE),
            ScanResult("REF-CTN-001", ScanSource.MANUAL),
            ScanResult("ctn-001", ScanSource.EXTERNAL_SCANNER),
        )
        scans.forEach { scan ->
            val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
            flow.scan(scan); runCurrent()
            assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step, scan.value)
            flow.confirmCard(); runCurrent()
            assertEquals(1, backend.cartonCalls, scan.value)
        }
    }

    @Test fun `tracking number matches the single open carton and confirms`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("TRK-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step)
        assertEquals("TRACKING NUMBER", flow.state.value.carton!!.matchedOn)
        flow.confirmCard(); runCurrent()
        assertEquals(1, backend.cartonCalls)
        assertEquals(1, flow.state.value.session!!.tally.receivedCartons)
        assertEquals("RECEIVED", flow.state.value.session!!.cartonCards.single().status)
    }

    @Test fun `confirm carton records the scan source and type`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER, ScanSymbology.QR)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals("QR", backend.cartonScanType)
        assertEquals("EXTERNAL_SCANNER", backend.cartonSource)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
    }

    @Test fun `wrong carton identifier is a device mismatch: logged, never confirmed`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("CTN-NOPE", ScanSource.MANUAL)); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals("NOT MATCHED", flow.state.value.message!!.title)
        assertEquals(1, backend.mismatchCalls)
        assertEquals("CARTON", backend.mismatchCardType)
        assertEquals("MANUAL", backend.mismatchScanType)
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, flow.state.value.session!!.tally.receivedCartons)
    }

    @Test fun `already received carton is rejected locally with no write at all`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(cartonCards = current.cartonCards.map { it.copy(status = "RECEIVED") })
        }
        val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals("CARTON ALREADY RECEIVED", flow.state.value.message!!.title)
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, backend.mismatchCalls)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
    }

    @Test fun `tracking with several open cartons is ambiguous and asks for the specific carton`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(cartonCards = current.cartonCards + current.cartonCards[0].copy(
                id = "carton-2", externalCartonId = "CTN-002", reference = "REF-CTN-002",
                cartonNumber = 2, totalCartons = 2, identifiers = listOf("CTN-002", "REF-CTN-002")))
        }
        val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("TRK-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals("SEVERAL CARTONS MATCH", flow.state.value.message!!.title)
        assertTrue(flow.state.value.message!!.detail.contains("CTN-001"))
        assertTrue(flow.state.value.message!!.detail.contains("CTN-002"))
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, backend.mismatchCalls)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
    }

    @Test fun `multiple cards stay independent: each card confirmed on its own lane`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(
                productCards = current.productCards.map { it.copy(expected = 1, remaining = 1) } +
                    ProductCard(id = "line-2", sku = "SKU-B", productName = "Second product",
                        expected = 1, received = 0, remaining = 1, status = "EXPECTED", identifiers = listOf("SKU-B")),
                cartonCards = current.cartonCards + CartonCard(id = "carton-2", externalCartonId = "CTN-002",
                    cartonNumber = 2, totalCartons = 2, trackingNumber = "TRK-001", status = "EXPECTED",
                    identifiers = listOf("CTN-002")),
                tally = ReceivingTally(expectedCartons = 2, receivedCartons = 0, expectedProducts = 2, receivedProducts = 0,
                    expectedUnits = 2, receivedUnits = 0, openDiscrepancies = 0, shortUnits = 2, overageUnits = 0, unexpectedProducts = 0, missingCartons = 2),
            )
        }
        val flow = workflow(backend); open(flow)
        // Two independent carton cards.
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        flow.scan(ScanResult("CTN-002", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(2, backend.cartonCalls)
        assertEquals(2, flow.state.value.session!!.tally.receivedCartons)
        // Two independent product cards.
        toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        flow.scan(ScanResult("SKU-B", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(2, backend.productCalls)
        assertEquals(2, flow.state.value.session!!.tally.receivedUnits)
        assertEquals(2, flow.state.value.session!!.productCards.filter { it.status == "RECEIVED" }.size)
        // The two card sets never merged into a single list.
        assertEquals(2, flow.state.value.session!!.productCards.size)
        assertEquals(2, flow.state.value.session!!.cartonCards.size)
    }

    // ============================ MODES / LANES ============================
    @Test fun `produit and carton are real workflow entries and never write`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        toProduct(flow)
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertEquals(listOf("arrivals", "active:WAR-001", "start"), backend.calls)
        toCarton(flow)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals(0, backend.productCalls)
        assertEquals(0, backend.cartonCalls)
        assertEquals(0, backend.mismatchCalls)
    }

    @Test fun `mode selection before arrival makes no stock request`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend)
        toProduct(flow)
        assertEquals(ReceivingStep.ARRIVAL, flow.state.value.step)
        assertEquals(listOf("arrivals"), backend.calls)
    }

    @Test fun `a product scan in the carton lane is a carton mismatch, never a product confirm`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow) // CARTONS mode
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertEquals("NOT MATCHED", flow.state.value.message!!.title)
        assertEquals("CARTON", backend.mismatchCardType)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `switching modes discards an unsubmitted review without writing`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA)); runCurrent()
        toCarton(flow)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
        assertNull(flow.state.value.product)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `cancel review returns to the lane without submitting`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA)); runCurrent()
        flow.continueScanning(); runCurrent()
        assertEquals(ReceivingStep.PRODUCT, flow.state.value.step)
        assertNull(flow.state.value.product)
        assertEquals(0, backend.productCalls)
    }

    @Test fun `rapid mode taps during a scan do not enqueue a transition`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL))
        repeat(20) { flow.selectMode(ReceivingMode.PRODUCTS) }
        runCurrent()
        assertEquals(ReceivingMode.CARTONS, flow.state.value.mode)
        assertEquals(ReceivingStep.REVIEW_CARTON, flow.state.value.step)
    }

    // ============================ LIFECYCLE ============================
    @Test fun `pause stops capture and resume restores the lane`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.pause(); runCurrent()
        assertEquals(ReceivingStep.PAUSED, flow.state.value.step)
        assertFalse(flow.state.value.canScan)
        val calls = backend.calls.size
        flow.scan(ScanResult("CTN-001", ScanSource.MANUAL)); runCurrent()
        assertEquals(calls, backend.calls.size)
        flow.resume(); runCurrent()
        assertEquals("RECEIVING", flow.state.value.session!!.status)
        assertEquals(ReceivingStep.CARTON, flow.state.value.step)
    }

    @Test fun `server pause during a scan immediately stops capture`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        backend.current = backend.current.copy(status = "PAUSED")
        flow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.PAUSED, flow.state.value.step)
        assertFalse(flow.state.value.canScan)
    }

    @Test fun `worker cannot close a session with variance`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        // The fixture session has an open shortfall (1 carton + 2 units missing).
        flow.reviewCompletion(); runCurrent()
        flow.complete(); runCurrent()
        assertEquals(0, backend.completionCalls)
        assertEquals("SUPERVISOR REQUIRED", flow.state.value.message!!.title)
    }

    @Test fun `authorized supervisor delegates completion to the gateway`() = runTest {
        val backend = ReceivingBackend()
        val flow = workflow(backend, permissions = workerPermissions + "receiving.resolve_discrepancy"); open(flow)
        flow.reviewCompletion(); runCurrent(); flow.complete(); runCurrent()
        assertEquals(1, backend.completionCalls)
        assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)
    }

    @Test fun `next arrival resets to the fresh queue`() = runTest {
        val backend = ReceivingBackend().apply { current = current.copy(status = "COMPLETED") }
        val flow = workflow(backend); open(flow)
        flow.nextArrival(); runCurrent()
        assertEquals(ReceivingStep.ARRIVAL, flow.state.value.step)
        assertNull(flow.state.value.session)
        assertEquals("WAR-001", flow.state.value.arrivals.single().code)
    }

    // ============================ JOURNAL / FAILURES ============================
    @Test fun `lost confirm response creates a persistent stop marker with no automatic retry`() = runTest {
        val backend = ReceivingBackend().apply { confirmFailure = TransportFailure(true) }
        val journal = MemoryJournal(); val flow = workflow(backend, journal); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertEquals(ReceivingStep.RECONCILE, flow.state.value.step)
        assertEquals(MutationKind.CONFIRM_PRODUCT, journal.read()!!.kind)
        assertFalse(flow.state.value.canScan)
        flow.confirmCard(); runCurrent()
        assertEquals(1, backend.productCalls)
    }

    @Test fun `definite permission rejection does not leave an uncertain write marker`() = runTest {
        val backend = ReceivingBackend().apply { confirmFailure = WorkerRepository.ApiException(403, "Missing required permission(s): receiving.execute") }
        val journal = MemoryJournal(); val flow = workflow(backend, journal); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertNull(journal.read())
        assertEquals("ACTION NOT ALLOWED", flow.state.value.message!!.title)
    }

    @Test fun `final 401 ends the workflow and keeps mutations disabled`() = runTest {
        val backend = ReceivingBackend().apply { confirmFailure = WorkerRepository.ApiException(401, "Session revoked") }
        val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.confirmCard(); runCurrent()
        assertTrue(flow.state.value.authExpired)
        assertFalse(flow.state.value.canMutate)
    }

    @Test fun `storage failure prevents dispatch`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal(); val flow = workflow(backend, journal)
        journal.failRecording = true
        open(flow)
        assertEquals(0, backend.startCalls)
        assertTrue(flow.state.value.storageBlocked)
    }

    @Test fun `previous worker pending operation is not disclosed to next worker`() = runTest {
        val backend = ReceivingBackend()
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "other-worker", MutationKind.CONFIRM_PRODUCT, "private-session", subject = "private-sku", createdAt = 1) }
        val flow = workflow(backend, journal)
        assertNull(flow.state.value.session)
        assertTrue(backend.calls.isEmpty())
        assertFalse(flow.state.value.message!!.detail.contains("private-sku"))
        assertEquals(ReceivingStep.RECONCILE, flow.state.value.step)
    }

    @Test fun `server closed session resolves the device hold without replay`() = runTest {
        val backend = ReceivingBackend().apply { current = current.copy(status = "COMPLETED") }
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "worker", MutationKind.CONFIRM_CARTON, "session", createdAt = 1) }
        val flow = workflow(backend, journal)
        assertNull(journal.read())
        assertEquals(ReceivingStep.COMPLETE, flow.state.value.step)
        assertEquals(0, backend.cartonCalls)
    }

    @Test fun `unresolved card confirmation is not inferred from aggregate counters`() = runTest {
        val backend = ReceivingBackend().apply { current = current.copy(tally = current.tally.copy(receivedUnits = 12)) }
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "worker", MutationKind.CONFIRM_PRODUCT, "session", "WAR-001", "Sku/a-01", 1) }
        val flow = workflow(backend, journal)
        assertEquals(ReceivingStep.RECONCILE, flow.state.value.step)
        assertEquals(0, backend.productCalls)
        flow.refresh(); runCurrent()
        assertNotNull(journal.read())
        assertFalse(flow.state.value.canMutate)
    }

    @Test fun `offline and revoked permission stop mutations rather than enqueue`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow); toProduct(flow)
        flow.scan(ScanResult("Sku/a-01", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        flow.updateAccess(workerPermissions, false); flow.confirmCard(); runCurrent()
        flow.updateAccess(setOf("receiving.view"), true); flow.confirmCard(); runCurrent()
        assertEquals(0, backend.productCalls)
        assertFalse(flow.state.value.canMutate)
    }

    // ============================ EXCEPTIONS ============================
    @Test fun `exception requires an actual reason and reports it`() = runTest {
        val backend = ReceivingBackend(); val flow = workflow(backend); open(flow)
        flow.reportException("   "); runCurrent(); assertEquals(0, backend.flagCalls)
        flow.reportException("Seal damaged"); runCurrent()
        assertEquals(1, backend.flagCalls)
        assertEquals("EXCEPTION REPORTED", flow.state.value.message!!.title)
    }

    @Test fun `worker cannot resolve discrepancies; supervisor can`() = runTest {
        val backend = ReceivingBackend().apply {
            current = current.copy(discrepancies = listOf(DiscrepancyRow(id = "d1", type = "OVERAGE", status = "OPEN", reason = "Overage on SKU-1")))
        }
        val flow = workflow(backend); open(flow)
        flow.resolveException("d1", "Approved by floor supervisor"); runCurrent()
        assertEquals(0, backend.calls.count { it == "resolve" })
        val supervisor = workflow(backend, permissions = workerPermissions + "receiving.resolve_discrepancy"); open(supervisor)
        supervisor.resolveException("d1", "Approved"); runCurrent()
        assertEquals(1, backend.calls.count { it == "resolve" })
    }
}
