@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.ReceivingReportState
import com.ayrovi.worker.domain.ReceivingReportWorkflow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.*

/**
 * CONFIRMATION REPORT (ORDER 01) — workflow contract tests.
 *
 * Session resolution (first arrival with an open session), live view load,
 * draft/damage/submit mutations with reload, lock semantics, and the exact
 * backend JSON contract (unknown keys tolerated).
 */
class ReceivingReportWorkflowTest {
    private val perms = setOf("receiving.view", "receiving.execute")
    private val json = Json { ignoreUnknownKeys = true }

    private fun view(
        status: String = "NONE",
        description: String? = null,
        photos: List<ReportPhotoView> = emptyList(),
    ) = ReceivingReportView(
        session = ReportSessionView(id = "s1", code = "WRS-1", status = "RECEIVING"),
        arrival = ReportArrivalView(id = "a1", code = "WAR-001", customerName = "Client", storeName = "Store"),
        taskStatus = "IN_PROGRESS",
        reportStatus = status,
        reportId = if (status == "NONE") null else "r1",
        totals = ReportTotals(
            expectedProducts = 2, confirmedProducts = 1, missingProducts = 1,
            expectedUnits = 8, scannedUnits = 7, confirmedUnits = 6, missingUnits = 1, damagedUnits = 1,
            expectedCartons = 2, receivedCartons = 1, missingCartons = 1,
        ),
        lines = listOf(
            ReportLineView(
                receivingProductId = "p1", sku = "SKU-A", reference = "SKU-A", productName = "Shirt",
                expectedQuantity = 5, scannedQuantity = 5, confirmedQuantity = 4,
                missingQuantity = 0, damagedQuantity = 1, result = "DAMAGED", note = "torn",
            ),
            ReportLineView(
                receivingProductId = "p2", sku = "SKU-B", reference = "SKU-B", productName = "Pants",
                expectedQuantity = 3, scannedQuantity = 2, confirmedQuantity = 2,
                missingQuantity = 1, damagedQuantity = 0, result = "MISSING",
            ),
        ),
        manual = ReportManualView(description = description, observation = null),
        photos = photos,
        actor = ReportActorView(workerId = "w1", workerName = "Worker"),
    )

    private fun session(id: String) = ReceivingSession(
        id = id, code = "WRS-1", status = "RECEIVING", startedAt = "2026-09-09T00:00:00Z",
        tally = ReceivingTally(
            expectedCartons = 2, receivedCartons = 1, expectedProducts = 2, receivedProducts = 1,
            expectedUnits = 8, receivedUnits = 7, openDiscrepancies = 0, shortUnits = 1,
            overageUnits = 0, unexpectedProducts = 0, missingCartons = 1,
        ),
    )

    /** Report double: delegates everything else to the shared HOME double. */
    private class ReportBackend(
        val arrivals: List<ArrivalRow> = listOf(ArrivalRow(id = "a1", code = "WAR-001")),
        val sessions: Map<String, ReceivingSession?> = mapOf("WAR-001" to null),
        var current: ReceivingReportView? = null,
        var failure: Exception? = null,
        /** ORDER 04 direct endpoint stub (null = nothing / legacy backend path). */
        var direct: ReceivingSession? = null,
        var directFailure: Exception? = null,
    ) : ReceivingGateway by HomeBackend() {
        val calls = mutableListOf<String>()
        var lastDraft: Triple<String?, String?, List<ReportPhotoInput>>? = null
        var lastDamage: Triple<String, Int, String?>? = null

        override suspend fun arrivals(): List<ArrivalRow> {
            calls += "arrivals"
            failure?.let { throw it }
            return arrivals
        }

        override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? {
            calls += "active:$arrivalIdOrCode"
            failure?.let { throw it }
            return sessions[arrivalIdOrCode]
        }

        override suspend fun activeReceivingSession(): ReceivingSession? {
            calls += "active-direct"
            directFailure?.let { throw it }
            return direct
        }

        override suspend fun report(sessionId: String): ReceivingReportView {
            calls += "report"
            failure?.let { throw it }
            return checkNotNull(current) { "no report stubbed" }
        }

        override suspend fun saveReportDraft(
            sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
        ): ReceivingReportView {
            calls += "draft"
            failure?.let { throw it }
            lastDraft = Triple(description, observation, photos)
            val next = checkNotNull(current).copy(
                reportStatus = "DRAFT", reportId = "r1",
                manual = ReportManualView(description = description, observation = observation),
                photos = photos.map { ReportPhotoView(id = "ph", dataUrl = it.dataUrl, caption = it.caption) },
            )
            current = next
            return next
        }

        override suspend fun markDamage(sessionId: String, lineId: String, quantity: Int, note: String?): DamageResultView {
            calls += "damage"
            failure?.let { throw it }
            lastDamage = Triple(lineId, quantity, note)
            return DamageResultView(lineId = lineId, verification = LineVerificationView(result = "DAMAGED"))
        }

        override suspend fun submitReport(
            sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
        ): ReceivingReportView {
            calls += "submit"
            failure?.let { throw it }
            lastDraft = Triple(description, observation, photos)
            val next = checkNotNull(current).copy(reportStatus = "SUBMITTED")
            current = next
            return next
        }
    }

    private fun TestScope.backend(
        arrivals: List<ArrivalRow> = listOf(ArrivalRow(id = "a1", code = "WAR-001")),
        withSession: Boolean = true,
        status: String = "NONE",
    ): ReportBackend {
        val s = if (withSession) session("s1") else null
        return ReportBackend(arrivals = arrivals, sessions = mapOf("WAR-001" to s), current = view(status))
    }

    private fun TestScope.workflow(backend: ReportBackend, permissions: Set<String> = perms): ReceivingReportWorkflow =
        ReceivingReportWorkflow(backend, permissions, this)

    // ----------------------------- RESOLUTION --------------------------------
    @Test fun `initialize resolves the open session and loads the live view`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        val state = flow.state.value
        assertEquals("s1", state.sessionId)
        assertEquals("WRS-1", state.sessionCode)
        assertEquals("WAR-001", state.arrivalCode)
        assertEquals("NONE", state.reportStatus)
        assertFalse(state.locked)
        assertTrue(state.canMutate)
        assertEquals(8, state.report?.totals?.expectedUnits)
        assertEquals(2, state.report?.lines?.size)
        assertEquals("DAMAGED", state.report?.lines?.first()?.result)
        assertTrue(back.calls.contains("report"))
    }

    @Test fun `initialize uses the direct session endpoint first`() = runTest {
        val back = backend()
        back.direct = session("s9")
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        assertEquals("s9", flow.state.value.sessionId)
        assertTrue(back.calls.contains("active-direct"))
        assertFalse(back.calls.contains("arrivals"), "a direct hit must skip the arrival loop")
        assertTrue(back.calls.contains("report"))
    }

    @Test fun `direct endpoint failure falls back to the arrival loop`() = runTest {
        val back = backend()
        back.directFailure = WorkerRepository.ApiException(404, "no direct endpoint on this backend")
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        assertEquals("s1", flow.state.value.sessionId)
        assertTrue(back.calls.contains("active-direct"))
        assertTrue(back.calls.contains("arrivals"), "legacy backends still resolve through the loop")
        assertTrue(back.calls.contains("report"))
    }

    @Test fun `no open session shows the empty state`() = runTest {
        val flow = workflow(backend(withSession = false))
        flow.initialize(); runCurrent()
        val state = flow.state.value
        assertTrue(state.noSession)
        assertNull(state.report)
        assertFalse(state.canMutate)
    }

    @Test fun `no reportable session anywhere shows the empty state`() = runTest {
        val back = backend(withSession = false)
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        val state = flow.state.value
        assertTrue(state.noSession)
        assertNull(state.report)
        assertFalse(state.canMutate)
        assertTrue(back.calls.contains("active-direct"))
        assertTrue(back.calls.contains("arrivals"))
    }

    @Test fun `missing permission disables mutations`() = runTest {
        val flow = workflow(backend(), permissions = setOf("receiving.view"))
        flow.initialize(); runCurrent()
        assertFalse(flow.state.value.canMutate)
    }

    // ----------------------------- MUTATIONS ---------------------------------
    @Test fun `draft save persists manual fields and photos`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        val photos = listOf(ReportPhotoInput("data:image/jpeg;base64,AAA", "box"))
        flow.saveDraft("checked twice", null, photos); runCurrent()
        val state = flow.state.value
        assertEquals("DRAFT", state.reportStatus)
        assertEquals("checked twice", state.report?.manual?.description)
        assertEquals(1, state.report?.photos?.size)
        assertEquals("box", state.report?.photos?.first()?.caption)
        assertEquals(MessageTone.SUCCESS, state.message?.tone)
        assertEquals(photos, back.lastDraft?.third)
    }

    @Test fun `damage declares units and reloads the view`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        flow.damage("p2", 1, "stain"); runCurrent()
        assertEquals(Triple("p2", 1, "stain"), back.lastDamage)
        assertEquals(2, back.calls.count { it == "report" }, "view must reload after damage")
        assertEquals(MessageTone.SUCCESS, flow.state.value.message?.tone)
    }

    @Test fun `submit locks the report and disables mutations`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        flow.submit(null, "ok", emptyList()); runCurrent()
        val state = flow.state.value
        assertEquals("SUBMITTED", state.reportStatus)
        assertTrue(state.locked)
        assertTrue(state.justSubmitted)
        assertFalse(state.canMutate)
        assertTrue(back.calls.contains("submit"))
    }

    @Test fun `locked report blocks every mutation`() = runTest {
        val back = backend(status = "SUBMITTED")
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        assertTrue(flow.state.value.locked)
        flow.saveDraft("x", null, emptyList())
        flow.damage("p1", 1, null)
        flow.submit(null, null, emptyList())
        runCurrent()
        assertFalse(back.calls.contains("draft"))
        assertFalse(back.calls.contains("damage"))
        assertFalse(back.calls.contains("submit"))
    }

    @Test fun `more than ten photos are refused without a call`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        flow.submit(null, null, List(11) { ReportPhotoInput("data:image/jpeg;base64,x") })
        runCurrent()
        assertFalse(back.calls.contains("submit"))
    }

    // ------------------------------ FAILURES ---------------------------------
    @Test fun `conflict surfaces a worker-safe message`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        back.failure = WorkerRepository.ApiException(409, "Report is SUBMITTED — it is locked.")
        flow.submit(null, null, emptyList()); runCurrent()
        val message = flow.state.value.message
        assertNotNull(message)
        assertEquals(MessageTone.ERROR, message.tone)
        assertFalse(flow.state.value.justSubmitted)
    }

    @Test fun `unauthorized expires the session`() = runTest {
        val back = backend()
        val flow = workflow(back)
        flow.initialize(); runCurrent()
        back.failure = WorkerRepository.ApiException(401, "expired")
        flow.refresh(); runCurrent()
        assertTrue(flow.state.value.authExpired)
    }

    // ------------------------------ CONTRACT ---------------------------------
    @Test fun `report json decodes including unknown submit extras`() {
        val raw = """
        {"session":{"id":"s1","code":"WRS-1","status":"RECEIVING","startedAt":"2026-09-09T00:00:00Z"},
         "arrival":{"id":"a1","code":"WAR-001","customerName":"Client","storeName":"Store","status":"EXPECTED"},
         "taskStatus":"REPORT_SUBMITTED","reportStatus":"SUBMITTED","reportId":"r1",
         "totals":{"expectedProducts":1,"confirmedProducts":1,"missingProducts":0,"damagedProducts":0,
          "expectedUnits":5,"scannedUnits":5,"confirmedUnits":5,"missingUnits":0,"damagedUnits":0,
          "expectedCartons":1,"receivedCartons":1,"missingCartons":0},
         "lines":[{"receivingProductId":"p1","sku":"SKU-A","reference":"SKU-A","productName":"Shirt",
          "expectedQuantity":5,"scannedQuantity":5,"confirmedQuantity":5,"missingQuantity":0,"damagedQuantity":0,
          "result":"CONFIRMED","note":null}],
         "manual":{"description":null,"observation":"ok"},
         "photos":[{"id":"ph1","lineId":null,"dataUrl":"data:image/jpeg;base64,AAA","caption":"box","takenBy":"w1","takenAt":"2026-09-09T01:00:00Z"}],
         "actor":{"workerId":"w1","workerName":"Worker","stationId":null,"stationCode":"ST-1","deviceType":"ANDROID_TERMINAL","deviceName":"CT40"},
         "submittedAt":"2026-09-09T02:00:00Z","reviewedAt":null,"closedAt":null,"reviewNote":null,
         "handoffReadyAt":"2026-09-09T02:00:00Z","notifiedAdmins":2}
        """.trimIndent()
        val view = json.decodeFromString(ReceivingReportView.serializer(), raw)
        assertEquals("SUBMITTED", view.reportStatus)
        assertEquals("WRS-1", view.session.code)
        assertEquals(5, view.totals.confirmedUnits)
        assertEquals("CONFIRMED", view.lines.single().result)
        assertEquals("ok", view.manual?.observation)
        assertEquals(1, view.photos.size)
        assertEquals("ST-1", view.actor?.stationCode)
    }

    @Test fun `state helpers derive lock and mutation rights`() {
        val open = ReceivingReportState(authorized = true, loading = false, report = view("DRAFT"))
        assertFalse(open.locked)
        assertTrue(open.canMutate)
        val sent = open.copy(report = view("SUBMITTED"))
        assertTrue(sent.locked)
        assertFalse(sent.canMutate)
        val loading = open.copy(loading = true)
        assertFalse(loading.canMutate)
    }
}
