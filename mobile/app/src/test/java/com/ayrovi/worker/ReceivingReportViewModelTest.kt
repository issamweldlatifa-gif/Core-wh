@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.ArrivalRow
import com.ayrovi.worker.data.DamageResultView
import com.ayrovi.worker.data.HomeScanResult
import com.ayrovi.worker.data.ReceivingGateway
import com.ayrovi.worker.data.ReceivingHome
import com.ayrovi.worker.data.ReceivingReportView
import com.ayrovi.worker.data.ReceivingSession
import com.ayrovi.worker.data.ReceivingTally
import com.ayrovi.worker.data.ReportActorView
import com.ayrovi.worker.data.ReportArrivalView
import com.ayrovi.worker.data.ReportManualView
import com.ayrovi.worker.data.ReportPhotoInput
import com.ayrovi.worker.data.ReportSessionView
import com.ayrovi.worker.data.ReportTotals
import com.ayrovi.worker.presentation.ReceivingReportViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * REGRESSION — the report screen hung on OPENING REPORT forever because
 * activate() gated initialize() on `!loading` while the initial state IS
 * loading=true, so initialize() was never called. These tests prove
 * activate() actually opens the report (and only once).
 */
class ReceivingReportViewModelTest {
    private val perms = setOf("receiving.view", "receiving.execute")

    @AfterEach fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test fun `activate opens the report instead of hanging on loading`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val gateway = FakeReportGateway()
        val vm = ReceivingReportViewModel(gateway, perms)
        assertTrue(vm.state.value.loading, "fresh report starts loading")
        vm.activate(perms, true)
        advanceUntilIdle()
        val state = vm.state.value
        assertFalse(state.loading, "activate(available=true) must run initialize() so loading clears")
        assertEquals("s1", state.sessionId)
        assertNotNull(state.report)
        assertEquals(1, gateway.reportCalls)
    }

    @Test fun `activate twice initializes only once`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val gateway = FakeReportGateway()
        val vm = ReceivingReportViewModel(gateway, perms)
        vm.activate(perms, true)
        vm.activate(perms, true)
        advanceUntilIdle()
        assertEquals(1, gateway.reportCalls, "the report must open exactly once")
        assertFalse(vm.state.value.loading)
        assertNotNull(vm.state.value.report)
    }

    @Test fun `activate while unavailable waits, then opens when available`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val gateway = FakeReportGateway()
        val vm = ReceivingReportViewModel(gateway, perms)
        vm.activate(perms, false)
        advanceUntilIdle()
        assertTrue(vm.state.value.loading)
        assertEquals(0, gateway.reportCalls)
        vm.activate(perms, true)
        advanceUntilIdle()
        assertFalse(vm.state.value.loading)
        assertEquals("s1", vm.state.value.sessionId)
        assertNotNull(vm.state.value.report)
    }

    /** Minimal report double: direct session hit + canned view; the report never touches the rest. */
    private class FakeReportGateway : ReceivingGateway {
        var reportCalls = 0
        private val session = ReceivingSession(
            id = "s1", code = "WRS-1", status = "RECEIVING", startedAt = "2026-09-09T00:00:00Z",
            tally = ReceivingTally(
                expectedCartons = 1, receivedCartons = 1, expectedProducts = 1, receivedProducts = 1,
                expectedUnits = 5, receivedUnits = 5, openDiscrepancies = 0, shortUnits = 0,
                overageUnits = 0, unexpectedProducts = 0, missingCartons = 0,
            ),
        )
        private val view = ReceivingReportView(
            session = ReportSessionView(id = "s1", code = "WRS-1", status = "RECEIVING"),
            arrival = ReportArrivalView(id = "a1", code = "WAR-001", customerName = "Client", storeName = "Store"),
            taskStatus = "IN_PROGRESS",
            reportStatus = "NONE",
            reportId = null,
            totals = ReportTotals(
                expectedProducts = 1, confirmedProducts = 0, missingProducts = 0,
                expectedUnits = 5, scannedUnits = 5, confirmedUnits = 0, missingUnits = 0, damagedUnits = 0,
                expectedCartons = 1, receivedCartons = 1, missingCartons = 0,
            ),
            lines = emptyList(),
            manual = ReportManualView(description = null, observation = null),
            photos = emptyList(),
            actor = ReportActorView(workerId = "w1", workerName = "Worker"),
        )

        override suspend fun activeReceivingSession(): ReceivingSession? = session
        override suspend fun report(sessionId: String): ReceivingReportView {
            reportCalls++
            return view
        }

        override suspend fun receivingHome(): ReceivingHome = TODO("not used by the report")
        override suspend fun homeConfirmProduct(
            identifier: String, identifierType: String, quantity: Int,
            operationId: String, source: String, startedAt: String?,
        ): HomeScanResult = TODO("not used by the report")
        override suspend fun homeConfirmCarton(
            identifier: String, identifierType: String,
            operationId: String, source: String, startedAt: String?,
        ): HomeScanResult = TODO("not used by the report")
        override suspend fun registerPushToken(token: String, platform: String, deviceId: String?) = TODO("not used by the report")
        override suspend fun unregisterPushToken(token: String) = TODO("not used by the report")
        override suspend fun homeMismatch(
            cardType: String, identifier: String, identifierType: String, source: String, startedAt: String?,
        ): HomeScanResult = TODO("not used by the report")
        override suspend fun arrivals(): List<ArrivalRow> = TODO("not used by the report")
        override suspend fun receivingSession(sessionId: String): ReceivingSession = TODO("not used by the report")
        override suspend fun activeSession(arrivalIdOrCode: String): ReceivingSession? = TODO("not used by the report")
        override suspend fun startReceiving(arrivalIdOrCode: String): ReceivingSession = TODO("not used by the report")
        override suspend fun confirmProduct(
            sessionId: String, identifier: String, identifierType: String, quantity: Int,
            operationId: String, source: String, startedAt: String?,
        ): ReceivingSession = TODO("not used by the report")
        override suspend fun confirmCarton(
            sessionId: String, identifier: String, identifierType: String,
            operationId: String, source: String, startedAt: String?,
        ): ReceivingSession = TODO("not used by the report")
        override suspend fun reportMismatch(
            sessionId: String, cardType: String, identifier: String,
            identifierType: String, source: String, startedAt: String?,
        ): ReceivingSession = TODO("not used by the report")
        override suspend fun pauseSession(sessionId: String): ReceivingSession = TODO("not used by the report")
        override suspend fun resumeSession(sessionId: String): ReceivingSession = TODO("not used by the report")
        override suspend fun completeSession(sessionId: String): ReceivingSession = TODO("not used by the report")
        override suspend fun flagSession(sessionId: String, reason: String, sku: String?, code: String?): ReceivingSession =
            TODO("not used by the report")
        override suspend fun resolveDiscrepancy(discrepancyId: String, resolution: String): ReceivingSession =
            TODO("not used by the report")
        override suspend fun saveReportDraft(
            sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
        ): ReceivingReportView = TODO("not used by the report")
        override suspend fun markDamage(sessionId: String, lineId: String, quantity: Int, note: String?): DamageResultView =
            TODO("not used by the report")
        override suspend fun submitReport(
            sessionId: String, description: String?, observation: String?, photos: List<ReportPhotoInput>,
        ): ReceivingReportView = TODO("not used by the report")
    }
}
