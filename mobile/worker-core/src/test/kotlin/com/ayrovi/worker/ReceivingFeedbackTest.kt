@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.ayrovi.worker

import com.ayrovi.worker.data.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.*
import kotlinx.coroutines.test.*
import kotlin.test.*

class ReceivingFeedbackTest {
    private val permissions = setOf("receiving.view", "receiving.execute")
    private class Audio : AudioFeedback {
        var success = 0; var errors = 0; var warnings = 0; var throwOnPlay = false
        override fun success() { success++; if (throwOnPlay) error("no audio") }
        override fun error() { errors++; if (throwOnPlay) error("no audio") }
        override fun warning() { warnings++; if (throwOnPlay) error("no audio") }
        override fun notification() = Unit
    }
    private data class Harness(val flow: ReceivingWorkflow, val scanner: ScannerManager, val feedback: ReceivingFeedbackController, val audio: Audio)
    private fun TestScope.setup(backend: ReceivingBackend = ReceivingBackend(), journal: MemoryJournal = MemoryJournal()): Harness {
        val flow = ReceivingWorkflow(backend, journal, "worker", permissions, backgroundScope)
        val scanner = ScannerManager(clock = { testScheduler.currentTime }, initiallyEnabled = true)
        val audio = Audio()
        val feedback = ReceivingFeedbackController(flow, scanner, audio, backgroundScope, clock = { testScheduler.currentTime })
        feedback.setForeground(true); feedback.setConnection(ConnectionState.ONLINE)
        flow.updateAccess(permissions, true); flow.initialize(); runCurrent()
        return Harness(flow, scanner, feedback, audio)
    }

    @Test fun `valid arrival gives success audio and green phase then automatic next scan`() = runTest {
        val h = setup()
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(TerminalPhase.SUCCESS, h.feedback.state.value.feedback.phase)
        assertEquals("ARRIVAL FOUND", h.feedback.state.value.feedback.title)
        assertEquals(1, h.audio.success)
        assertEquals(ReceivingStep.CARTON, h.flow.state.value.step)
        advanceTimeBy(1_101); runCurrent()
        assertEquals(TerminalPhase.READY, h.feedback.state.value.feedback.phase)
    }

    @Test fun `product match gives success feedback with the product code`() = runTest {
        val h = setup()
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        h.flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        h.flow.scan(ScanResult("Sku/a-01", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(TerminalPhase.SUCCESS, h.feedback.state.value.feedback.phase)
        assertEquals("PRODUCT MATCH", h.feedback.state.value.feedback.title)
        assertEquals(ReceivingStep.REVIEW_PRODUCT, h.flow.state.value.step)
    }

    @Test fun `carton match gives success feedback with the carton code`() = runTest {
        val h = setup()
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        h.flow.scan(ScanResult("QR-CTN-001", ScanSource.CAMERA, ScanSymbology.QR)); runCurrent()
        assertEquals(TerminalPhase.SUCCESS, h.feedback.state.value.feedback.phase)
        assertEquals("CARTON MATCH", h.feedback.state.value.feedback.title)
        assertEquals(ReceivingStep.REVIEW_CARTON, h.flow.state.value.step)
    }

    @Test fun `device mismatch gives error feedback and an explicit NOT MATCHED title`() = runTest {
        val h = setup()
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        h.flow.selectMode(ReceivingMode.PRODUCTS); runCurrent()
        h.flow.scan(ScanResult("SKU-NOPE", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(TerminalPhase.ERROR, h.feedback.state.value.feedback.phase)
        assertEquals("NOT MATCHED", h.feedback.state.value.feedback.title)
        assertEquals(1, h.audio.errors)
    }

    @Test fun `unknown arrival returns to readiness without OK or another request`() = runTest {
        val backend = ReceivingBackend().apply { activeFailure = WorkerRepository.ApiException(404, "Arrival not found.") }
        val h = setup(backend)
        h.flow.scan(ScanResult("BAD-ARRIVAL", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        val calls = backend.calls.size
        assertEquals(TerminalPhase.ERROR, h.feedback.state.value.feedback.phase)
        assertEquals(1, h.audio.errors)
        advanceTimeBy(1_101); runCurrent()
        assertEquals(TerminalPhase.READY, h.feedback.state.value.feedback.phase)
        assertEquals(calls, backend.calls.size)
        assertEquals(0, backend.startCalls)
    }

    @Test fun `decoder capture alone never beeps warehouse success`() = runTest {
        val h = setup()
        h.scanner.capture("LABEL", ScanSource.EXTERNAL_SCANNER); runCurrent()
        assertEquals(0, h.audio.success)
    }

    @Test fun `empty invalid and duplicate scans give error feedback without workflow writes`() = runTest {
        val backend = ReceivingBackend(); val h = setup(backend)
        h.scanner.capture("", ScanSource.EXTERNAL_SCANNER); runCurrent()
        assertEquals(TerminalPhase.ERROR, h.feedback.state.value.feedback.phase)
        assertEquals(1, h.audio.errors)
        advanceTimeBy(1_101); runCurrent()
        h.scanner.capture("A\nB", ScanSource.MANUAL); runCurrent()
        assertEquals(2, h.audio.errors)
        h.scanner.capture("SAME", ScanSource.EXTERNAL_SCANNER)
        h.scanner.capture("SAME", ScanSource.EXTERNAL_SCANNER); runCurrent()
        assertEquals("ALREADY SCANNED", h.feedback.state.value.feedback.title)
        assertEquals(0, backend.startCalls)
    }

    @Test fun `held duplicate does not generate continuous beeping or reset timeout`() = runTest {
        val h = setup()
        h.scanner.capture("SKU", ScanSource.EXTERNAL_SCANNER)
        repeat(8) { h.scanner.capture("SKU", ScanSource.EXTERNAL_SCANNER); runCurrent(); advanceTimeBy(200) }
        runCurrent()
        assertEquals(1, h.audio.errors)
        assertEquals(TerminalPhase.READY, h.feedback.state.value.feedback.phase)
    }

    @Test fun `new scan replaces feedback without waiting for an animation`() = runTest {
        val h = setup()
        h.scanner.capture("", ScanSource.MANUAL); runCurrent()
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals("ARRIVAL FOUND", h.feedback.state.value.feedback.title)
        assertEquals(1, h.audio.success)
    }

    @Test fun `audio failure cannot prevent state advancement`() = runTest {
        val h = setup(); h.audio.throwOnPlay = true
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(ReceivingStep.CARTON, h.flow.state.value.step)
        assertEquals(TerminalPhase.SUCCESS, h.feedback.state.value.feedback.phase)
    }

    @Test fun `offline and uncertain result holds never become ready after timeout`() = runTest {
        val journal = MemoryJournal().apply { value = PendingMutation("held", "worker", MutationKind.CONFIRM_PRODUCT, "session", createdAt = 1) }
        val h = setup(journal = journal)
        advanceTimeBy(2_000); runCurrent()
        assertEquals(TerminalPhase.WARNING, h.feedback.state.value.feedback.phase)
        assertFalse(h.flow.state.value.canScan)
        assertNotNull(journal.read())
        val online = setup()
        online.feedback.setConnection(ConnectionState.OFFLINE); online.flow.updateAccess(permissions, false); runCurrent()
        advanceTimeBy(2_000); runCurrent()
        assertEquals(TerminalPhase.OFFLINE, online.feedback.state.value.feedback.phase)
    }

    @Test fun `station business refusal stays red and distinct from a connection problem`() = runTest {
        val h = setup(ReceivingBackend().apply { activeFailure = WorkerRepository.ApiException(403, "Arrival not assigned to this station.") })
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        assertEquals(TerminalPhase.ERROR, h.feedback.state.value.feedback.phase)
        assertEquals("Arrival not assigned to this station.", h.feedback.state.value.feedback.detail)
        assertFalse(h.flow.state.value.canScan)
        advanceTimeBy(1_101); runCurrent()
        assertEquals(TerminalPhase.ERROR, h.feedback.state.value.feedback.phase)
    }

    @Test fun `network recovery returns to readiness only after fresh authority`() = runTest {
        val h = setup()
        h.flow.updateAccess(permissions, false); h.feedback.setConnection(ConnectionState.OFFLINE); runCurrent()
        assertEquals(TerminalPhase.OFFLINE, h.feedback.state.value.feedback.phase)
        h.feedback.setConnection(ConnectionState.CHECKING); runCurrent()
        assertEquals(TerminalPhase.WAITING, h.feedback.state.value.feedback.phase)
        h.feedback.setConnection(ConnectionState.ONLINE); h.flow.updateAccess(permissions, true); runCurrent()
        assertEquals(TerminalPhase.READY, h.feedback.state.value.feedback.phase)
    }

    @Test fun `background feedback is not replayed or sounded on return`() = runTest {
        val h = setup(); h.feedback.setForeground(false)
        h.flow.scan(ScanResult("WAR-001", ScanSource.EXTERNAL_SCANNER)); runCurrent()
        h.feedback.setForeground(true); runCurrent()
        assertEquals(0, h.audio.success)
        assertEquals(TerminalPhase.READY, h.feedback.state.value.feedback.phase)
    }

    @Test fun `muted silent DND and unavailable audio respect system settings`() {
        assertTrue(AudioPolicy.mayPlay(2, false, true, true))
        assertFalse(AudioPolicy.mayPlay(0, false, true, true))
        assertFalse(AudioPolicy.mayPlay(2, true, true, true))
        assertFalse(AudioPolicy.mayPlay(2, false, false, true))
        assertFalse(AudioPolicy.mayPlay(2, false, true, false))
    }

    @Test fun `worker messages hide technical details but preserve business reasons`() {
        for (raw in listOf("Missing required permission(s): receiving.execute", "Prisma Exception at Client.query()", "HTTP 502 <html>trace</html>", "Bearer secret-token")) {
            val message = WorkerMessages.api(403, raw, false)
            assertFalse(message.detail.contains(raw))
        }
        assertEquals("Arrival not assigned to this station.", WorkerMessages.api(403, "Arrival not assigned to this station.", false).detail)
        assertNotEquals(WorkerMessages.api(409, "Wrong carton.", false).title, TransportFailure(false).toOperationalMessage().title)
    }
}
