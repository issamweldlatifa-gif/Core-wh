@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.BatchCreateIn
import com.ayrovi.worker.data.BatchCreatedPayload
import com.ayrovi.worker.data.BatchDetailPayload
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.BatchRowPayload
import com.ayrovi.worker.data.BatchSubmitIn
import com.ayrovi.worker.data.BatchSubmittedPayload
import com.ayrovi.worker.data.BatchUnitAddedPayload
import com.ayrovi.worker.data.BatchUnitIn
import com.ayrovi.worker.data.BatchUnitPayload
import com.ayrovi.worker.domain.BatchBuildWorkflow
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.identifierKindFor
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * BATCH BUILD workflow — the worker-side Phase 2 contract on-device:
 * create (customer in-app) -> ONE scan = ONE unit (same SKU ×10 = 10 units)
 * -> submit (replay-safe). The AYROVI identity always comes from the server.
 */
private class FakeBatchGateway : BatchGateway {
    var created = 0
    var added = mutableListOf<BatchUnitIn>()
    var submits = mutableListOf<BatchSubmitIn>()
    var failNext: Exception? = null
    var replayNext = false
    var nextCode = 0

    override suspend fun batchCreate(input: BatchCreateIn): BatchCreatedPayload {
        failNext?.let { throw it }
        created += 1
        val first = input.firstItem?.let {
            added += it
            BatchUnitAddedPayload(unit = BatchUnitPayload(code = "AYP-000000001"), replayed = false)
        }
        return BatchCreatedPayload(
            batch = BatchRowPayload(id = "b1", batchCode = "AYB-20260911-00001", status = "CREATED"),
            first = first, replayed = false,
        )
    }

    override suspend fun batchAddUnit(batchId: String, input: BatchUnitIn): BatchUnitAddedPayload {
        failNext?.let { throw it }
        added += input
        nextCode += 1
        val replayed = replayNext
        replayNext = false
        return BatchUnitAddedPayload(
            unit = BatchUnitPayload(code = "AYP-00000%04d".format(nextCode)),
            replayed = replayed,
        )
    }

    override suspend fun batchSubmit(batchId: String, input: BatchSubmitIn): BatchSubmittedPayload {
        failNext?.let { throw it }
        submits += input
        return BatchSubmittedPayload(batch = BatchRowPayload(id = batchId, batchCode = "AYB-20260911-00001", status = "SUBMITTED"))
    }

    override suspend fun batchOpen(): List<BatchRowPayload> {
        failNext?.let { throw it }
        return emptyList()
    }

    override suspend fun batchDetail(batchId: String): BatchDetailPayload {
        failNext?.let { throw it }
        return BatchDetailPayload(id = batchId, batchCode = "AYB-20260911-00001", status = "CREATED")
    }
}

private fun build(scope: kotlinx.coroutines.CoroutineScope): Pair<BatchBuildWorkflow, FakeBatchGateway> {
    val gateway = FakeBatchGateway()
    val workflow = BatchBuildWorkflow(gateway, scope) { "key-${java.util.UUID.randomUUID()}" }
    workflow.activate(authorized = true, serverAvailable = true)
    return workflow to gateway
}

class BatchBuildWorkflowTest {

    @Test
    fun `numeric codes classify as BARCODE, anything else as SKU`() {
        assertEquals("BARCODE" to "5901234567890", identifierKindFor(" 5901234567890 "))
        assertEquals("SKU" to "SB-123", identifierKindFor("SB-123"))
        assertEquals("SKU" to "SHORT7", identifierKindFor("SHORT7"))
    }

    @Test
    fun `create opens the batch and keeps the first scan as a unit`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Ahmed Akrmi", "REF-9", firstScan = "5901234567890")
        runCurrent()

        assertEquals(1, gateway.created)
        val state = wf.state.value
        assertEquals("AYB-20260911-00001", state.batch?.batchCode)
        assertEquals(1, state.units.size)
        assertEquals("AYP-000000001", state.lastAdded)
        val first = gateway.added.single()
        assertEquals("BARCODE", first.identifierType)
        assertEquals("5901234567890", first.originalBarcode)
    }

    @Test
    fun `ONE scan = ONE unit - the same SKU ten times yields ten AYP units`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        repeat(10) { wf.onScan("SB-123"); runCurrent() }

        assertEquals(10, gateway.added.size)
        assertEquals(10, wf.state.value.units.size)
        // Ten distinct units, ten distinct idempotency keys — repetition is
        // NOT a duplicate; a retried HTTP add would carry the SAME key.
        assertEquals(10, wf.state.value.units.map { it.ayp }.toSet().size)
        assertEquals(10, gateway.added.map { it.idempotencyKey }.toSet().size)
        assertEquals("SKU", gateway.added[0].identifierType)
        assertEquals("SB-123", gateway.added[0].originalSku)
    }

    @Test
    fun `a replayed add does NOT duplicate the unit row`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        gateway.replayNext = true
        wf.onScan("SB-123")
        runCurrent()

        assertEquals(1, wf.state.value.units.size)
        assertTrue(wf.state.value.message!!.title.contains("ALREADY"))
    }

    @Test
    fun `MANUAL adds carry NO invented original`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        wf.addManual()
        runCurrent()

        val unit = gateway.added.single()
        assertEquals("MANUAL", unit.identifierType)
        assertEquals(null, unit.identifierValue)
        assertEquals(null, unit.originalBarcode)
        assertEquals(null, unit.originalSku)
    }

    @Test
    fun `submit is refused while empty, stores a fresh key, then resets the build`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        wf.submit()
        runCurrent()
        assertFalse(wf.state.value.submittedDone)

        wf.onScan("SB-123")
        runCurrent()
        wf.submit()
        runCurrent()

        assertEquals(1, gateway.submits.size)
        assertTrue(gateway.submits.single().idempotencyKey.isNotEmpty())
        assertTrue(wf.state.value.submittedDone)
        assertEquals(null, wf.state.value.batch)
    }

    @Test
    fun `a failed add keeps the build intact and surfaces a worker-safe error`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        gateway.failNext = RuntimeException("prisma: P2002 unique constraint")
        wf.onScan("SB-123")
        runCurrent()

        val state = wf.state.value
        assertFalse(state.busy)
        assertEquals("AYB-20260911-00001", state.batch?.batchCode)
        assertEquals(MessageTone.ERROR, state.message!!.tone)
        assertFalse(state.message!!.detail.contains("prisma"))
    }

    @Test
    fun `scan is gated while busy - double fire cannot add twice`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.create("Client")
        runCurrent()
        wf.onScan("SB-123") // busy=true until advanced
        wf.onScan("SB-123") // must be ignored
        runCurrent()

        assertEquals(1, gateway.added.size)
    }
}
