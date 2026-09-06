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
import kotlinx.serialization.json.Json
import kotlin.test.*

class ReceivingWorkflowTest {
    private val workerPermissions = setOf("receiving.view", "receiving.execute")
    private fun TestScope.workflow(backend: ReceivingBackend, journal: MemoryJournal = MemoryJournal(), permissions: Set<String> = workerPermissions): ReceivingWorkflow =
        ReceivingWorkflow(backend, journal, "worker", permissions, this).also {
            it.updateAccess(permissions, true); it.initialize(); runCurrent()
            it.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        }
    private fun TestScope.open(workflow: ReceivingWorkflow) { workflow.openArrival("WAR-001"); runCurrent() }
    private fun TestScope.carton(workflow: ReceivingWorkflow) {
        workflow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        workflow.confirmCarton(); runCurrent()
    }
    private fun TestScope.product(workflow: ReceivingWorkflow, code: String = "Sku/a-01") {
        workflow.scan(ScanResult("RCN-000001", ScanSource.MANUAL)); runCurrent()
        workflow.scan(ScanResult(code, ScanSource.CAMERA)); runCurrent()
    }

    @Test fun `arrival queue is real gateway data`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend)
        assertEquals("WAR-001", workflow.state.value.arrivals.single().code)
        assertEquals(listOf("arrivals"), backend.calls)
    }
    @Test fun `identification is never carton acceptance`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        workflow.scan(ScanResult("CTN-001", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(ReceivingStep.CONFIRM_CARTON, workflow.state.value.step)
        assertEquals(0, backend.receiveCartonCalls)
        assertEquals(0, workflow.state.value.session!!.tally.receivedCartons)
        assertEquals("QR", backend.cartonScanType)
        assertEquals("CAMERA", backend.cartonSource)
    }
    @Test fun `unknown arrival preserves expected scanned and redirects to the queue`() = runTest {
        val backend = ReceivingBackend().apply { activeFailure = WorkerRepository.ApiException(404, "Expected arrival not found.") }
        val workflow = workflow(backend)
        workflow.scan(ScanResult("WAR-UNKNOWN", ScanSource.MANUAL)); runCurrent()
        assertEquals("WAR-UNKNOWN", workflow.state.value.message!!.scanned)
        assertEquals("AYROVI arrival code", workflow.state.value.message!!.expected)
        // Receiving audit: a WAR-looking code the backend does not know is an
        // operational redirect, never a raw lookup error shown to the operator.
        assertEquals("ARRIVAL NOT FOUND", workflow.state.value.message!!.title)
        assertEquals("This arrival is not available. Select an Arrival from the queue or scan its WAR- code.", workflow.state.value.message!!.detail)
        assertEquals(0, backend.startCalls)
    }
    @Test fun `non arrival scan at the ARRIVAL gate never reaches the arrival endpoint`() = runTest {
        // Root cause regression (both modes): the first scan was always sent to
        // the ExpectedArrival lookup, so carton/product/customer barcodes came
        // back as "Expected arrival not found". They are answered locally now.
        listOf("CTN-001", "Sku/a-01", "ARR-CRM-CARD", "CUST-0091").forEach { scanned ->
            val backend = ReceivingBackend(); val workflow = workflow(backend)
            workflow.scan(ScanResult(scanned, ScanSource.EXTERNAL_SCANNER)); runCurrent()
            val message = workflow.state.value.message
            assertEquals("NOT AN ARRIVAL CODE", message!!.title)
            assertEquals("This is not an Arrival code. Select an Arrival from the queue or scan a WAR- code.", message.detail)
            assertEquals(scanned, message.scanned)
            assertEquals("AYROVI arrival code", message.expected)
            assertEquals(ReceivingStep.ARRIVAL, workflow.state.value.step)
            assertTrue(backend.calls.none { it.startsWith("active:") || it == "start" })
        }
    }
    @Test fun `war arrival scan keeps the existing backend path in every mode`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend) // PRODUCTS mode helper
        workflow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertTrue(backend.calls.contains("active:WAR-001"))
        assertEquals(1, backend.startCalls)
        assertEquals("RECEIVING", workflow.state.value.session!!.status)
    }
    @Test fun `queue selection opens the arrival through the same domain path`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend)
        workflow.openArrival(workflow.state.value.arrivals.single().code ?: error("queue code")); runCurrent()
        assertEquals(1, backend.startCalls)
        assertTrue(backend.calls.contains("active:WAR-001"))
        assertNotNull(workflow.state.value.session)
    }
    @Test fun `confirmation calls real carton command and uses received event`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow)
        assertEquals(1, backend.receiveCartonCalls)
        assertEquals("EXTERNAL_SCANNER", backend.cartonSource)
        assertEquals(1, workflow.state.value.session!!.tally.receivedCartons)
        assertEquals(ReceivingStep.TOTE, workflow.state.value.step)
        assertNull(journal.read())
    }
    @Test fun `correct backend status RECEIVING permits pause and resume`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        workflow.pause(); runCurrent()
        assertEquals(ReceivingStep.PAUSED, workflow.state.value.step)
        val calls = backend.calls.size
        workflow.scan(ScanResult("CTN-001", ScanSource.MANUAL)); runCurrent()
        assertEquals(calls, backend.calls.size)
        workflow.resume(); runCurrent()
        assertEquals("RECEIVING", workflow.state.value.session!!.status)
        assertEquals(ReceivingStep.CARTON, workflow.state.value.step)
    }
    @Test fun `server pause during carton identification immediately stops capture`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        backend.current = backend.current.copy(status = "PAUSED")
        workflow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.PAUSED, workflow.state.value.step)
        assertFalse(workflow.state.value.canScan)
        workflow.confirmCarton(); runCurrent()
        assertEquals(0, backend.receiveCartonCalls)
    }
    @Test fun `rapid scans and double confirm never queue extra receipts`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        repeat(20) { workflow.scan(ScanResult("CTN-001", ScanSource.EXTERNAL_SCANNER)) }
        runCurrent()
        assertEquals(1, backend.calls.count { it == "scan-carton" })
        repeat(20) { workflow.confirmCarton() }; runCurrent()
        assertEquals(1, backend.receiveCartonCalls)
    }
    @Test fun `existing active session is recovered instead of starting again`() = runTest {
        val backend = ReceivingBackend().apply { active = current }; val workflow = workflow(backend); open(workflow)
        assertEquals(0, backend.startCalls)
        assertEquals("session", workflow.state.value.session!!.id)
    }
    @Test fun `wrong shipment keeps actual backend reason and cannot confirm`() = runTest {
        val backend = ReceivingBackend().apply { wrongShipment = true }; val workflow = workflow(backend); open(workflow)
        workflow.scan(ScanResult("CTN-OTHER", ScanSource.MANUAL)); runCurrent()
        assertEquals("Carton CTN-OTHER belongs to shipment SHP-OTHER", workflow.state.value.message!!.detail)
        workflow.confirmCarton(); runCurrent()
        assertEquals(0, backend.receiveCartonCalls)
    }
    @Test fun `unknown carton is never accepted`() = runTest {
        val backend = ReceivingBackend().apply { unknownCarton = true }; val workflow = workflow(backend); open(workflow)
        workflow.scan(ScanResult("unknown", ScanSource.MANUAL)); runCurrent()
        assertEquals("CARTON NOT FOUND", workflow.state.value.message!!.title)
        assertEquals(ReceivingStep.CARTON, workflow.state.value.step)
        assertNull(workflow.state.value.carton)
    }
    @Test fun `already received source carton does not count twice`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow)
        workflow.changeCarton(); workflow.scan(ScanResult("CTN-001", ScanSource.MANUAL)); runCurrent()
        assertTrue(workflow.state.value.carton!!.alreadyReceived)
        workflow.confirmCarton(); runCurrent()
        assertEquals(1, backend.receiveCartonCalls)
    }
    @Test fun `tote must be backend ACTIVE and RECEIVING`() = runTest {
        for (invalid in listOf("CUSTOMER" to "ACTIVE", "RECEIVING" to "CLOSED")) {
            val backend = ReceivingBackend().apply { tote = tote.copy(type = invalid.first, status = invalid.second) }
            val workflow = workflow(backend); open(workflow); carton(workflow)
            workflow.scan(ScanResult("BIN-001", ScanSource.MANUAL)); runCurrent()
            assertEquals(ReceivingStep.TOTE, workflow.state.value.step)
            assertNull(workflow.state.value.tote)
            assertEquals(0, backend.articleCalls)
        }
    }
    @Test fun `product review does not mutate and preserves exact SKU`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        assertEquals(ReceivingStep.REVIEW_PRODUCT, workflow.state.value.step)
        assertEquals("Sku/a-01", workflow.state.value.product!!.scan.value)
        assertEquals(0, backend.articleCalls)
        assertEquals(2, workflow.state.value.product!!.product!!.expected)
    }
    @Test fun `reference is not silently substituted for a SKU`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow, "REF-ONLY")
        assertNull(workflow.state.value.product!!.product)
        assertEquals("PRODUCT NOT EXPECTED", workflow.state.value.message!!.title)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `one confirmed article uses one existing endpoint and server totals`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        repeat(10) { workflow.confirmProduct() }; runCurrent()
        assertEquals(1, backend.articleCalls)
        assertEquals("Sku/a-01", backend.receivedSku)
        assertEquals("RCN-000001", backend.receivedTote)
        assertEquals("CTN-001", backend.sourceCarton)
        assertEquals("ART-00000001", workflow.state.value.receipt!!.articleCode)
        assertEquals(1, workflow.state.value.session!!.tally.receivedUnits)
        assertEquals(ReceivingStep.RESULT, workflow.state.value.step)
    }
    @Test fun `confirmed receipt survives interruption until explicit operator acknowledgement`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal()
        val first = workflow(backend, journal); open(first); carton(first); product(first)
        first.confirmProduct(); runCurrent()
        assertEquals("ART-00000001", journal.read()!!.confirmedReceipt!!.articleCode)
        val restored = workflow(backend, journal)
        assertEquals(ReceivingStep.RESULT, restored.state.value.step)
        assertTrue(restored.state.value.restoredReceipt)
        assertEquals("ART-00000001", restored.state.value.receipt!!.articleCode)
        assertFalse(restored.state.value.canScan)
        assertFalse(restored.state.value.canMutate)
        assertTrue(restored.state.value.canAcknowledgeReceipt)
        restored.confirmProduct(); restored.pause(); runCurrent()
        assertEquals(1, backend.articleCalls)
        restored.nextProduct(); runCurrent()
        assertNull(journal.read())
        assertEquals(ReceivingStep.CARTON, restored.state.value.step)
        assertEquals(1, backend.articleCalls)
    }
    @Test fun `acknowledgement read failure retains recorded unit and never resubmits`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal()
        val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        backend.readFailure = TransportFailure(false)
        workflow.nextProduct(); runCurrent()
        assertNotNull(journal.read()!!.confirmedReceipt)
        assertEquals(ReceivingStep.RESULT, workflow.state.value.step)
        assertEquals(1, backend.articleCalls)
    }
    @Test fun `zero negative fractional overflow and bulk quantities do not send any receipt`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        for (quantity in listOf("0", "-1", "1.5", "", "999999999999999999999", "2", "100000")) {
            workflow.setQuantity(quantity); workflow.confirmProduct(); runCurrent()
            assertEquals(0, backend.articleCalls, quantity)
            assertEquals(ReceivingStep.REVIEW_PRODUCT, workflow.state.value.step)
        }
    }
    @Test fun `unexpected article is written with exception not falsely rejected`() = runTest {
        val backend = ReceivingBackend().apply { articleReply = ArticleScanResult(
            flash = FlashView(kind = "UNEXPECTED_ARTICLE", article = Json.parseToJsonElement("""{"code":"ART-UNEXPECTED"}""")), matched = false) }
        val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow, "NOT-EXPECTED")
        workflow.confirmProduct(); runCurrent()
        assertTrue(workflow.state.value.receipt!!.withException)
        assertEquals("RECEIVED WITH EXCEPTION", workflow.state.value.message!!.title)
    }
    @Test fun `lost response creates persistent stop marker with no automatic retry`() = runTest {
        val backend = ReceivingBackend().apply { articleFailure = TransportFailure(true) }
        val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertEquals(ReceivingStep.RECONCILE, workflow.state.value.step)
        assertEquals(MutationKind.RECEIVE_ARTICLE, journal.read()!!.kind)
        assertFalse(workflow.state.value.canScan)
        workflow.confirmProduct(); workflow.nextProduct(); workflow.pause(); runCurrent()
        assertEquals(1, backend.articleCalls)
        assertFalse(backend.calls.contains("pause"))
    }
    @Test fun `process recovery never infers receipt from aggregate quantity or replays it`() = runTest {
        val backend = ReceivingBackend().apply { current = current.copy(tally = current.tally.copy(receivedUnits = 12)) }
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "worker", MutationKind.RECEIVE_ARTICLE, "session", "WAR-001", "Sku/a-01", "RCN-000001", 1) }
        val workflow = workflow(backend, journal)
        assertEquals(ReceivingStep.RECONCILE, workflow.state.value.step)
        assertEquals(0, backend.articleCalls)
        workflow.refresh(); runCurrent()
        assertNotNull(journal.read())
        assertFalse(workflow.state.value.canMutate)
    }
    @Test fun `server closed session resolves device hold without replay`() = runTest {
        val backend = ReceivingBackend().apply { current = current.copy(status = "COMPLETED") }
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "worker", MutationKind.RECEIVE_ARTICLE, "session", createdAt = 1) }
        val workflow = workflow(backend, journal)
        assertNull(journal.read())
        assertEquals(ReceivingStep.COMPLETE, workflow.state.value.step)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `previous worker pending operation is not disclosed to next worker`() = runTest {
        val backend = ReceivingBackend()
        val journal = MemoryJournal().apply { value = PendingMutation("pending", "other-worker", MutationKind.RECEIVE_ARTICLE, "private-session", subject = "private-sku", createdAt = 1) }
        val workflow = workflow(backend, journal)
        assertNull(workflow.state.value.session)
        assertTrue(backend.calls.isEmpty())
        assertFalse(workflow.state.value.message!!.detail.contains("private-sku"))
        assertEquals(ReceivingStep.RECONCILE, workflow.state.value.step)
    }
    @Test fun `storage failure prevents dispatch`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal(); val workflow = workflow(backend, journal)
        journal.failRecording = true
        open(workflow)
        assertEquals(0, backend.startCalls)
    }
    @Test fun `definite permission rejection does not leave an uncertain write marker`() = runTest {
        val backend = ReceivingBackend().apply { articleFailure = WorkerRepository.ApiException(403, "Missing required permission(s): receiving.execute") }
        val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertNull(journal.read())
        assertEquals("ACTION NOT ALLOWED", workflow.state.value.message!!.title)
    }
    @Test fun `final 401 ends workflow and keeps unauthorized actions disabled`() = runTest {
        val backend = ReceivingBackend().apply { articleFailure = WorkerRepository.ApiException(401, "Session revoked") }
        val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertTrue(workflow.state.value.authExpired)
        assertFalse(workflow.state.value.canMutate)
    }
    @Test fun `malformed successful receipt is held for reconciliation not shown as success`() = runTest {
        val backend = ReceivingBackend().apply { articleReply = ArticleScanResult(flash = FlashView(kind = "OK")) }
        val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertNull(workflow.state.value.receipt)
        assertEquals(ReceivingStep.RECONCILE, workflow.state.value.step)
        assertNotNull(journal.read())
    }
    @Test fun `non-string article code cannot be persisted as receipt evidence`() = runTest {
        val backend = ReceivingBackend().apply { articleReply = ArticleScanResult(
            flash = FlashView(kind = "ARTICLE_RECEIVED", article = Json.parseToJsonElement("{\"code\":123}")), matched = true) }
        val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertEquals(ReceivingStep.RECONCILE, workflow.state.value.step)
        assertNull(journal.read()!!.confirmedReceipt)
        assertNull(workflow.state.value.receipt)
    }
    @Test fun `followup GET failure never repeats a confirmed receipt`() = runTest {
        val backend = ReceivingBackend(); val journal = MemoryJournal(); val workflow = workflow(backend, journal); open(workflow); carton(workflow); product(workflow)
        backend.readFailure = TransportFailure(false)
        workflow.confirmProduct(); runCurrent()
        assertNotNull(workflow.state.value.receipt)
        assertNotNull(journal.read()!!.confirmedReceipt)
        workflow.confirmProduct(); runCurrent()
        assertEquals(1, backend.articleCalls)
        backend.readFailure = null
        workflow.nextProduct(); runCurrent()
        assertEquals(ReceivingStep.PRODUCT, workflow.state.value.step)
    }
    @Test fun `offline and revoked permission stop mutations rather than enqueue`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        workflow.updateAccess(workerPermissions, false); workflow.confirmProduct(); runCurrent()
        workflow.updateAccess(setOf("receiving.view"), true); workflow.confirmProduct(); runCurrent()
        assertEquals(0, backend.articleCalls)
        assertFalse(workflow.state.value.canMutate)
    }
    @Test fun `completion review cannot bypass source carton confirmation`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        workflow.reviewCompletion(); runCurrent()
        workflow.nextProduct(); runCurrent()
        assertEquals(ReceivingStep.CARTON, workflow.state.value.step)
        workflow.changeTote()
        assertEquals(ReceivingStep.CARTON, workflow.state.value.step)
        assertEquals(0, backend.articleCalls)
    }
    @Test fun `permission refusal stops writes until fresh permission context`() = runTest {
        val backend = ReceivingBackend().apply { articleFailure = WorkerRepository.ApiException(403, "Permission revoked") }
        val workflow = workflow(backend); open(workflow); carton(workflow); product(workflow)
        workflow.confirmProduct(); runCurrent()
        assertFalse(workflow.state.value.canMutate)
        workflow.confirmProduct(); runCurrent()
        assertEquals(1, backend.articleCalls)
        backend.articleFailure = null
        workflow.updateAccess(workerPermissions, true)
        workflow.confirmProduct(); runCurrent()
        assertEquals(2, backend.articleCalls)
    }
    @Test fun `worker cannot close discrepancies or invent supervisor permission`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        workflow.reviewCompletion(); runCurrent(); workflow.complete(); runCurrent()
        assertEquals(0, backend.completionCalls)
        assertEquals("SUPERVISOR REQUIRED", workflow.state.value.message!!.title)
    }
    @Test fun `authorized supervisor delegates completion to the gateway`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend, permissions = workerPermissions + "receiving.resolve_discrepancy"); open(workflow)
        workflow.reviewCompletion(); runCurrent(); workflow.complete(); runCurrent()
        assertEquals(1, backend.completionCalls)
        assertEquals(ReceivingStep.COMPLETE, workflow.state.value.step)
    }
    @Test fun `exception requires actual reason and never claims rejection`() = runTest {
        val backend = ReceivingBackend(); val workflow = workflow(backend); open(workflow)
        workflow.reportException("   "); runCurrent(); assertEquals(0, backend.flagCalls)
        workflow.reportException("Seal damaged"); runCurrent()
        assertEquals(1, backend.flagCalls)
        assertEquals("EXCEPTION REPORTED", workflow.state.value.message!!.title)
        assertTrue(workflow.state.value.message!!.detail.contains("supervisor"))
    }
}
