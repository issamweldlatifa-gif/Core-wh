package com.ayrovi.worker

import android.content.Intent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.data.*
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.presentation.*
import com.ayrovi.worker.scanner.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic intents exercise the EXISTING Honeywell adapter, not a claim of physical trigger certification. */
@RunWith(AndroidJUnit4::class)
class DeviceAwareReceivingTest {
    @get:Rule val compose = createComposeRule()
    private val permissions = setOf("receiving.view", "receiving.execute")

    private fun render(model: ReceivingViewModel, device: WorkerDevice, recovery: String? = null) {
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(permissions, true, recovery) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(if (device == WorkerDevice.CT40) TerminalThemeMode.INDUSTRIAL else TerminalThemeMode.WHITE) {
                    ReceivingScreen(model, "Test Worker · W-001", "ST-RCV-01", "ONLINE", {}, {}, {}, device)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
    }
    @Test fun sameViewportGetsDistinctPhoneTouchAndCt40ScannerPresentation() {
        val model = ReceivingViewModel(ReceivingUiGateway(), UiJournal(), "worker", permissions)
        var device by mutableStateOf(WorkerDevice.PHONE)
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(permissions, true, null) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(if (device == WorkerDevice.CT40) TerminalThemeMode.INDUSTRIAL else TerminalThemeMode.WHITE) {
                    ReceivingScreen(model, "Test Worker · W-001", "ST-RCV-01", "ONLINE", {}, {}, {}, device)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("PHONE_RECEIVING").assertExists()
        compose.onNodeWithText("SOFTWARE SCAN").assertExists().assertHeightIsAtLeast(TerminalTokens.primaryTouch)
        compose.onNodeWithTag("CT40_DEVICE_VISUAL").assertDoesNotExist()
        saveNativeScreenshot(compose, "phone-arrival-ready")
        compose.runOnIdle { device = WorkerDevice.CT40 }
        compose.onNodeWithTag("CT40_RECEIVING").assertExists()
        compose.onNodeWithTag("PHONE_RECEIVING").assertDoesNotExist()
        compose.onNodeWithTag("CT40_DEVICE_VISUAL").assertIsDisplayed()
        compose.onNodeWithText("SOFTWARE SCAN").assertDoesNotExist()
        compose.onNodeWithText("USE CAMERA").assertDoesNotExist()
        compose.onNodeWithText("Use the side trigger").assertIsDisplayed()
        compose.onNodeWithText("MANUAL CODE").assertIsDisplayed()
        compose.onNodeWithTag("CT40_HEADER").assertHeightIsAtMost(100.dp)
        saveNativeScreenshot(compose, "ct40-arrival-ready")
    }
    @Test fun ct40SyntheticHardwareJourneyValidatesThenConfirmsThroughOneCore() {
        val backend = ReceivingUiGateway(expectedCartons = 1)
        val journal = UiJournal()
        val audio = RecordingAudio()
        val model = ReceivingViewModel(backend, journal, "worker", permissions, audio)
        render(model, WorkerDevice.CT40)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val coordinator = ScanCoordinator({ _, _, _ -> }, {}, model.scanner, model::onScan)
        val receiver = HoneywellScanner(context, onBarcode = {
            coordinator.onScanned(it, false, ScanSource.EXTERNAL_SCANNER.name)
        }, isSupported = { true })
        fun trigger(code: String) { context.sendBroadcast(Intent(HoneywellScanner.ACTION_BARCODE_READ).setPackage(context.packageName).putExtra("data", code)) }
        fun await(step: ReceivingStep) = compose.waitUntil(8_000) { model.state.value.step == step && !model.state.value.busy }
        try {
            compose.runOnIdle { receiver.start() }
            trigger("WRONG-ARRIVAL")
            compose.waitUntil(5_000) { model.ui.value.feedback.phase == TerminalPhase.ERROR }
            assertEquals(1, audio.negative)
            assertEquals(0, backend.writes)
            saveNativeScreenshot(compose, "ct40-invalid-arrival")
            compose.waitUntil(5_000) { model.ui.value.feedback.phase == TerminalPhase.READY }
            trigger("WAR-TEST-001"); await(ReceivingStep.CARTON)
            compose.waitUntil(5_000) { model.ui.value.feedback.title == "ARRIVAL FOUND" }
            assertEquals(1, audio.positive)
            saveNativeScreenshot(compose, "ct40-arrival-found")
            trigger("CTN-TEST"); await(ReceivingStep.CONFIRM_CARTON)
            assertEquals("Identifying is not accepting", 0, backend.writes)
            compose.onNode(hasText("CONFIRM CARTON") and hasClickAction()).performClick(); await(ReceivingStep.CARTON)
            assertEquals(1, backend.writes)
            compose.onNode(hasText("PRODUIT") and hasClickAction()).performClick(); await(ReceivingStep.TOTE)
            trigger("RCN-TEST"); await(ReceivingStep.PRODUCT)
            trigger("SKU-TEST"); await(ReceivingStep.REVIEW_PRODUCT)
            compose.onNode(hasText("CONFIRM 1 UNIT") and hasClickAction()).performClick(); await(ReceivingStep.RESULT)
            assertEquals(2, backend.writes)
            assertNotNull(journal.pending?.confirmedReceipt)
            compose.onNode(hasText("ACKNOWLEDGE") and hasClickAction()).performClick(); await(ReceivingStep.PRODUCT)
            assertNull(journal.pending)
            compose.onNodeWithContentDescription("Task actions").performClick()
            compose.onNodeWithText("REVIEW COMPLETION").performScrollTo().performClick(); await(ReceivingStep.REVIEW_COMPLETE)
            compose.onNode(hasText("COMPLETE") and hasClickAction()).performClick(); await(ReceivingStep.COMPLETE)
            assertEquals(3, backend.writes)
        } finally { compose.runOnIdle { receiver.stop() } }
    }
    @Test fun noArrivalsShowsOperationalEmptyStateAndNoScanAction() {
        val model = ReceivingViewModel(ReceivingUiGateway(empty = true), UiJournal(), "worker", permissions)
        render(model, WorkerDevice.PHONE)
        compose.onNodeWithText("NO ARRIVALS WAITING").assertIsDisplayed()
        compose.onNodeWithText("REFRESH QUEUE").assertIsDisplayed()
        compose.onNodeWithText("SOFTWARE SCAN").assertDoesNotExist()
        compose.onNodeWithText("LEGACY WORKFLOW", substring = true).assertDoesNotExist()
        assertFalse(model.captureAllowed)
    }
    @Test fun queueUsesCompactRealBadgesAndUnavailableIsNotMigrationCopy() {
        val state = WorkerAppState(signedIn = true, verified = true, me = MeResponse(user = MeUser(id = "worker")),
            tasks = listOf("receiving", "sorting", "putaway").map { TerminalTask(key = it, ready = true) }, receivingArrivals = 3)
        var opened = false; var signedOut = false
        compose.setContent { Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
            AyroviTerminalTheme(TerminalThemeMode.INDUSTRIAL) {
                WorkerWorkQueue(state, WorkerDevice.CT40, "ONLINE", "Test Worker · W-001", "ST-RCV-01", {}, { signedOut = true }, {}, {}) { opened = true }
            }
        } }
        compose.onNodeWithContentDescription("3 waiting").assertExists()
        compose.onNodeWithText("SORTING").assertIsNotEnabled()
        compose.onNodeWithText("PUTAWAY").assertIsNotEnabled()
        compose.onNodeWithText("RECEIVING").performClick()
        compose.runOnIdle { assertTrue(opened) }
        compose.onNodeWithText("SIGN OUT").performClick()
        compose.runOnIdle { assertTrue(signedOut) }
        compose.onNodeWithText("LEGACY", substring = true).assertDoesNotExist()
        saveNativeScreenshot(compose, "ct40-work-queue")
    }
}
