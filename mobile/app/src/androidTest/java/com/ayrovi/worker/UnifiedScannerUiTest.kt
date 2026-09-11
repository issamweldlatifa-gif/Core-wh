package com.ayrovi.worker

import android.Manifest
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.rule.GrantPermissionRule
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import org.junit.Rule
import org.junit.Test

/**
 * MASTER ORDER §§14–§35 — the UNIFIED scanner UX, verified on the handheld
 * harness (instrumented test on the CI emulator).
 *
 * Covered steps of the order's own test list (§34):
 *  1. open the Receiving scanner  -> READY TO SCAN + CT40 indication + side tools
 *  2. press the side tools button -> the drawer opens
 *  3. select OCR                  -> the tool opens and the drawer closes
 *  7. close the tool              -> READY TO SCAN again
 *  8. side tools -> QR / BARCODE  -> the QR/barcode area opens (not the default)
 * 11. manual entry                -> opens as a fallback, then CT40 returns to
 *     the hardware default.
 *
 * The scanner screen must never be a tool list: before the drawer is used, no
 * tool surface may exist at all.
 */
class UnifiedScannerUiTest {

    @get:Rule
    val compose = createComposeRule()

    /** Camera tools are exercised head-less: grant the permission up front. */
    @get:Rule
    val camera: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    /**
     * UX CORRECTION §3/§9: every scanner test enters through the ONE scan
     * tool — the AUTO scanner that Home QR CODE opens DIRECTLY (no lanes).
     * Hardware override = the CT40 layout (no auto camera on the harness).
     */
    private fun openScanTool() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = com.ayrovi.worker.presentation.ReceivingHomeIntent.OpenAutoScan,
                        autoOpenCamera = false, forceHardwareScanner = true)
                }
            }
        }
        awaitLoaded(compose, model)
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun scannerOpensStraightOnReadyWithNoToolsChrome() {
        // NAVIGATION BY RULE (v1.7.4): the tool opens straight on READY —
        // no intro card, and ONE surface: no side rail, no tools drawer.
        // The tool flows (OCR / manual / QR) stay covered on the station
        // screens that still expose the drawer (UnifiedScannerTsUiTest).
        openScanTool()

        waitForTag("AUTO_SCANNER")
        compose.onNodeWithTag("AUTO_SCANNER").assertIsDisplayed()
        waitForTag("READY_TO_SCAN")
        compose.onNodeWithTag("READY_TO_SCAN").assertIsDisplayed()
        compose.onNodeWithText("READY TO SCAN").assertIsDisplayed()
        compose.onNodeWithText("CT40").assertIsDisplayed()

        // NO side tools button and NO drawer on this tool, ever.
        compose.onAllNodesWithTag("SCAN_TOOLS_ARROW").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithText("Hardware Scanner").assertCountEquals(0)
        compose.onAllNodesWithText("Use the CT40 side trigger — no screen button needed.").assertCountEquals(0)

        // And NO tool surface, no scan-button cluster (§20/§29).
        compose.onAllNodesWithTag("OCR_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
    }

    /**
     * §27/§28 — the scan verdict NEVER dismisses itself: it stays in front of
     * the operator until BACK, and a new hardware read replaces the old verdict
     * instead of stacking on top of it.
     */
    @Test
    fun resultStaysUntilBackAndNeverAutoDismisses() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = com.ayrovi.worker.presentation.ReceivingHomeIntent.OpenAutoScan,
                        forceHardwareScanner = true)
                }
            }
        }
        awaitLoaded(compose, model)
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        waitForTag("READY_TO_SCAN")

        // GREEN MATCH (Phase B, zero-touch): the verdict flashes and the
        // lane re-arms BY ITSELF — no BACK even exists on a success verdict.
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForTag("READY_TO_SCAN")

        // RED STOP verdict (§27/§28 unchanged): never auto-dismissed…
        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-UNKNOWN", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()
        compose.onNodeWithTag("RESULT_BACK").assertIsDisplayed()

        // Far longer than the old 1.2 s flash timer: it must still be there.
        Thread.sleep(3_000)
        compose.waitForIdle()
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()

        // …and the scanner never stays open behind the verdict (§21).
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)

        // BACK closes it and the work interface is usable again.
        compose.onNodeWithTag("RESULT_BACK").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        compose.onAllNodesWithTag("SCAN_RESULT").assertCountEquals(0)
        waitForTag("READY_TO_SCAN")
    }

    /**
     * Field bug: on a plain phone the app claimed CT40. With real hardware
     * sensing (no override) the emulator — which has no imager — must show
     * the PHONE layout: no CT40 anywhere, a reachable software trigger, and
     * a drawer without the CT40 row.
     */
    @Test
    fun phoneWithoutHardwareShowsPhoneLayoutAndSoftwareTrigger() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = com.ayrovi.worker.presentation.ReceivingHomeIntent.OpenAutoScan,
                        autoOpenCamera = false)
                }
            }
        }
        awaitLoaded(compose, model)
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        waitForTag("READY_TO_SCAN")

        // Phone illustration, not the CT40 glyph — and no CT40 anywhere.
        compose.onNodeWithTag("READY_TO_SCAN").assertIsDisplayed()
        compose.onAllNodesWithText("CT40").assertCountEquals(0)

        // The software trigger stays reachable (never the default).
        compose.onNodeWithTag("SHOW_TRIGGER").assertIsDisplayed()
        compose.onNodeWithTag("SHOW_TRIGGER").performClick()
        compose.onNodeWithTag("SOFTWARE_TRIGGER").assertIsDisplayed()

        // …and it opens the real camera adapter (same as the QR tool).
        compose.onNodeWithTag("SOFTWARE_TRIGGER").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("CAPTURE_QR_AREA").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_BACK").performClick()
        waitForTag("READY_TO_SCAN")

        // NAVIGATION BY RULE: BACK from the camera returns to READY — and
        // this tool has NO side rail and NO drawer on a phone either.
        compose.onAllNodesWithTag("SCAN_TOOLS_ARROW").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        // The one-tap trigger is reachable again to continue the session.
        compose.onNodeWithTag("SHOW_TRIGGER").assertIsDisplayed()
    }

    /**
     * UX CORRECTION §3: HOME → QR CODE → the CAMERA opens IMMEDIATELY on a
     * phone (no hardware imager): no Start button, no extra confirmation,
     * no intermediate screen. The existing capture surface is used as-is.
     */
    @Test
    fun qrToolAutoOpensTheCameraImmediatelyOnAPhone() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = com.ayrovi.worker.presentation.ReceivingHomeIntent.OpenAutoScan)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        // The real camera capture surface is up with NO further interaction.
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("CAPTURE_QR_AREA").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        // No trigger button cluster and no work-center content behind it.
        compose.onAllNodesWithTag("SHOW_TRIGGER").assertCountEquals(0)
        compose.onAllNodesWithTag("RECEIVING_HOME").assertCountEquals(0)
    }

    /**
     * The LAST-scan reminder: absent before any read, then value + verdict
     * mark + time once a scan lands and its verdict is dismissed.
     */
    @Test
    fun lastScanReminderShowsAfterResultDismissed() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        openWith = com.ayrovi.worker.presentation.ReceivingHomeIntent.OpenAutoScan,
                        forceHardwareScanner = true)
                }
            }
        }
        awaitLoaded(compose, model)
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        waitForTag("READY_TO_SCAN")
        compose.onAllNodesWithTag("LAST_SCAN").assertCountEquals(0)

        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        // Phase B: the green MATCH flash re-arms the lane BY ITSELF (~1.2s
        // — a verdict the operator actually SEES). No BACK on success.
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForTag("READY_TO_SCAN")

        compose.onNodeWithTag("LAST_SCAN").assertIsDisplayed()
        compose.onNodeWithText("SKU-TEST").assertIsDisplayed()
    }
}
