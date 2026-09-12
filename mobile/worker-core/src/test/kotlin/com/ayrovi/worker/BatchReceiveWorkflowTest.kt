@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.BatchCompleteReceivingIn
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.BatchReceiveUnitIn
import com.ayrovi.worker.data.BatchReceiveUnitPayload
import com.ayrovi.worker.data.BatchRowPayload
import com.ayrovi.worker.data.BatchStartedPayload
import com.ayrovi.worker.data.BatchCreateIn
import com.ayrovi.worker.data.BatchCreatedPayload
import com.ayrovi.worker.data.BatchDetailPayload
import com.ayrovi.worker.data.BatchSubmitIn
import com.ayrovi.worker.data.BatchSubmittedPayload
import com.ayrovi.worker.data.BatchUnitAddedPayload
import com.ayrovi.worker.data.BatchUnitIn
import com.ayrovi.worker.data.BatchUnitPayload
import com.ayrovi.worker.domain.BatchReceiveWorkflow
import com.ayrovi.worker.domain.MessageTone
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * BATCH RECEIVE workflow — the receiving-side Phase 2 contract:
 * queue -> START -> ONE scan = ONE unit (echo = no-op, server truth counters)
 * -> COMPLETE gated on 10/10 (client mirror + server enforcement).
 */
private class FakeReceiveGateway : BatchGateway {
    val queue = mutableListOf<BatchRowPayload>()
    val receiveCalls = mutableListOf<BatchReceiveUnitIn>()
    val completeKeys = mutableListOf<String>()
    var started = 0
    var completed = 0
    var failNext: Exception? = null
    var scanned = 0
    var expected = 10

    override suspend fun batchCreate(input: BatchCreateIn) = BatchCreatedPayload()
    override suspend fun batchAddUnit(batchId: String, input: BatchUnitIn) = BatchUnitAddedPayload()
    override suspend fun batchSubmit(batchId: String, input: BatchSubmitIn) = BatchSubmittedPayload()
    override suspend fun batchOpen(): List<BatchRowPayload> = emptyList()
    override suspend fun batchDetail(batchId: String) = BatchDetailPayload()

    override suspend fun batchReceiveQueue(): List<BatchRowPayload> {
        failNext?.let { throw it }
        return queue
    }

    override suspend fun batchStartReceiving(batchId: String): BatchStartedPayload {
        failNext?.let { throw it }
        started += 1
        return BatchStartedPayload(
            batch = BatchRowPayload(
                id = batchId, batchCode = "AYB-20260911-00007", status = "RECEIVING_IN_PROGRESS",
                totalExpected = expected, totalScanned = 0,
            ),
        )
    }

    override suspend fun batchReceiveUnit(batchId: String, unitCode: String): BatchReceiveUnitPayload {
        failNext?.let { throw it }
        receiveCalls += BatchReceiveUnitIn(unitCode)
        val already = unitCode in alreadySeen
        if (!already) { scanned += 1; alreadySeen += unitCode }
        return BatchReceiveUnitPayload(
            unitCode = unitCode, alreadyReceived = already,
            totalScanned = scanned, totalExpected = expected,
        )
    }

    override suspend fun batchCompleteReceiving(batchId: String, input: BatchCompleteReceivingIn): BatchStartedPayload {
        failNext?.let { throw it }
        completeKeys += input.idempotencyKey
        completed += 1
        return BatchStartedPayload(
            batch = BatchRowPayload(id = batchId, batchCode = "AYB-20260911-00007", status = "RECEIVING_COMPLETED"),
        )
    }

    val alreadySeen = mutableListOf<String>()
}

private fun build(scope: kotlinx.coroutines.CoroutineScope): Pair<BatchReceiveWorkflow, FakeReceiveGateway> {
    val gateway = FakeReceiveGateway()
    val workflow = BatchReceiveWorkflow(gateway, scope) { "rkey-${java.util.UUID.randomUUID()}" }
    workflow.activate(authorized = true, serverAvailable = true)
    return workflow to gateway
}

class BatchReceiveWorkflowTest {

    @Test
    fun `queue shows sent + in-progress batches`() = runTest {
        val (wf, gateway) = build(this)
        gateway.queue += BatchRowPayload(id = "b1", batchCode = "AYB-20260911-00007", status = "SENT_TO_RECEIVING", totalExpected = 10)
        gateway.queue += BatchRowPayload(id = "b2", batchCode = "AYB-20260911-00008", status = "RECEIVING_IN_PROGRESS", totalExpected = 6)
        runCurrent()
        assertEquals(2, wf.state.value.queue.size)
        assertTrue(wf.state.value.loaded)
    }

    @Test
    fun `start opens the batch and shows the expected count`() = runTest {
        val (wf, _) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        val state = wf.state.value
        assertEquals("AYB-20260911-00007", state.batch?.batchCode)
        assertEquals(10, state.totalExpected)
        assertEquals(0, state.totalScanned)
        assertTrue(state.canScan)
    }

    @Test
    fun `ONE scan = ONE unit - counters are SERVER truth`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        wf.onScan(" AYP-000000001 ")
        runCurrent()
        wf.onScan("AYP-000000002")
        runCurrent()

        assertEquals(2, gateway.receiveCalls.size)
        assertEquals("AYP-000000001", gateway.receiveCalls[0].unitCode) // trimmed
        assertEquals(2, wf.state.value.totalScanned)
        assertEquals(10, wf.state.value.totalExpected)
        assertEquals(MessageTone.SUCCESS, wf.state.value.message!!.tone)
    }

    @Test
    fun `re-reading the SAME label is a server no-op - never double counts`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        wf.onScan("AYP-000000001")
        runCurrent()
        val before = wf.state.value.totalScanned
        wf.onScan("AYP-000000001") // echo
        runCurrent()

        assertEquals(before, wf.state.value.totalScanned)
        assertEquals(MessageTone.WARNING, wf.state.value.message!!.tone)
        assertTrue(wf.state.value.message!!.title.contains("ALREADY"))
    }

    @Test
    fun `complete is refused client-side while units are missing - no doomed call`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        wf.onScan("AYP-000000001")
        runCurrent()
        wf.complete()
        runCurrent()

        assertEquals(0, gateway.completeKeys.size)
        assertTrue(wf.state.value.message!!.detail.contains("missing"))
        assertFalse(wf.state.value.completeReady)
    }

    @Test
    fun `complete at 10-10 stores a fresh idempotency key and shows the summary`() = runTest {
        val (wf, gateway) = build(this)
        gateway.expected = 2
        runCurrent()
        wf.start("b1")
        runCurrent()
        wf.onScan("AYP-000000001")
        runCurrent()
        wf.onScan("AYP-000000002")
        runCurrent()
        assertTrue(wf.state.value.completeReady)
        wf.complete()
        runCurrent()

        assertEquals(1, gateway.completeKeys.size)
        assertTrue(gateway.completeKeys.single().isNotEmpty())
        assertEquals("AYB-20260911-00007", wf.state.value.completed?.batchCode)
        assertEquals(null, wf.state.value.batch)
        assertTrue(wf.state.value.message!!.title.contains("COMPLETED"))
    }

    @Test
    fun `a failed scan keeps the session and surfaces a worker-safe error`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        gateway.failNext = RuntimeException("prisma: P2025 record not found")
        wf.onScan("AYP-000000009")
        runCurrent()

        val state = wf.state.value
        assertFalse(state.busy)
        assertEquals("AYB-20260911-00007", state.batch?.batchCode)
        assertEquals(MessageTone.ERROR, state.message!!.tone)
        assertFalse(state.message!!.detail.contains("prisma"))
    }

    @Test
    fun `double fire is gated - one scan enqueues exactly one call`() = runTest {
        val (wf, gateway) = build(this)
        runCurrent()
        wf.start("b1")
        runCurrent()
        wf.onScan("AYP-000000001") // busy claimed synchronously
        wf.onScan("AYP-000000001") // ignored
        runCurrent()

        assertEquals(1, gateway.receiveCalls.size)
    }
}
