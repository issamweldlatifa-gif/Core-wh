package com.ayrovi.worker

import android.Manifest
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertExists
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.rule.GrantPermissionRule
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.presentation.ReceivingHomeIntent
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import org.junit.Rule
import org.junit.Test

/**
 * OWNER ORDER — COMPLETE SCANNER UI & CONTINUOUS SCANNING FIX (v77).
 *
 * The acceptance sequence, executed on the CI emulator (instrumented):
 *   open scanner            → camera in the UPPER section, history below
 *   scan valid barcode      → green ✓ circle IN the camera
 *   indicator disappears    → scanning resumes, camera still open
 *   scan second barcode     → second success WITHOUT reopening the camera
 *   scan invalid barcode    → red ✕ circle + error recorded in the history
 *   retry with valid barcode→ success, camera never restarted
 *   review history          → every result still visible
 *   exit scanner            → camera released
 *
 * The emulator has no back camera, so the CameraX bind reports UNAVAILABLE —
 * which is itself a real session-history row (the actual adapter error).
 * Scans are injected through the workflow VM (the same entry the CT40
 * hardware trigger uses), so the verdicts are the REAL workflow verdicts.
 */
class ScannerContinuousUiTest {

    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val camera: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun historyItems(): Int = compose.onAllNodesWithTag("SCAN_HISTORY_ITEM").fetchSemanticsNodes().size

    private fun openPhoneScanner(): ReceivingHomeViewModel {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = ReceivingHomeIntent.OpenAutoScan)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        return model
    }

    @Test
    fun continuousScanningCameraNeverClosesAndHistoryGrows() {
        val model = openPhoneScanner()

        // ---- Layout: camera UPPER + history LOWER, ONE surface ----
        waitForTag("CAPTURE_QR_AREA")
        waitForTag("CAMERA_AREA")
        waitForTag("SCAN_HISTORY")
        compose.onNodeWithTag("CAMERA_AREA").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_CLOSE").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_TORCH").assertIsDisplayed()
        compose.onNodeWithText("NO BARCODE ON THE ARTICLE ?").assertIsDisplayed()
        // ANTI-DUPLICATION: while the camera is open there is NO second
        // success mark anywhere — no v75 verdict panel over the viewfinder.
        compose.onAllNodesWithTag("SCAN_RESULT").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_SUCCESS_MARK").assertCountEquals(0)
        saveNativeScreenshot(compose, "scanner-v77-layout")

        // Let the emulator's no-camera adapter notice (a REAL error row)
        // settle so the count math below is deterministic.
        Thread.sleep(2_500)
        compose.waitForIdle()
        val base = historyItems()

        // ---- Scan 1: VALID → green circle in the camera ----
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_FEEDBACK_OK")
        saveNativeScreenshot(compose, "scanner-v77-green-circle")
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("SCAN_FEEDBACK_OK").fetchSemanticsNodes().isEmpty() }
        // …the camera was NEVER closed…
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        // …and the result landed in the history.
        compose.waitUntil(5_000) { historyItems() == base + 1 }
        compose.onNodeWithText("SKU-TEST").assertExists()

        // ---- Scan 2: VALID → second success WITHOUT reopening anything ----
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST-2", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_FEEDBACK_OK")
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("SCAN_FEEDBACK_OK").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        compose.waitUntil(5_000) { historyItems() == base + 2 }
        compose.onNodeWithText("SKU-TEST-2").assertExists()

        // ---- Scan 3: INVALID → red circle + REAL error in the history ----
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-UNKNOWN", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_FEEDBACK_ERR")
        saveNativeScreenshot(compose, "scanner-v77-red-circle")
        // No green mark is ever shown for a failed scan.
        compose.onAllNodesWithTag("SCAN_FEEDBACK_OK").assertCountEquals(0)
        compose.waitUntil(6_000) { compose.onAllNodesWithTag("SCAN_FEEDBACK_ERR").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        compose.waitUntil(5_000) { historyItems() == base + 3 }

        // ---- Scan 4: retry VALID → success again, camera never restarted ----
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST-3", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_FEEDBACK_OK")
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("SCAN_FEEDBACK_OK").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        compose.waitUntil(5_000) { historyItems() == base + 4 }

        // ---- Review history: every scan result is still visible ----
        compose.onNodeWithText("SKU-TEST").assertExists()
        compose.onNodeWithText("SKU-TEST-2").assertExists()
        compose.onNodeWithText("SKU-TEST-3").assertExists()

        // ---- Exit: the camera is released ----
        compose.onNodeWithTag("TOOL_CLOSE").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("CAPTURE_QR_AREA").fetchSemanticsNodes().isEmpty() }
        compose.onAllNodesWithTag("SCAN_FEEDBACK_OK").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_FEEDBACK_ERR").assertCountEquals(0)
    }
}
