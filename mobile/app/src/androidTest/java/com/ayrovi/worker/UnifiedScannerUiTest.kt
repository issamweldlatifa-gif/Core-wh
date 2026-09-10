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

    private fun openProductScanner() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        forceHardwareScanner = true)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.PRODUCT_SCAN }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun scannerDefaultsToReadyToScanAndKeepsTheToolsInTheDrawer() {
        openProductScanner()

        // 1. DEFAULT: READY TO SCAN + CT40 indication + the single side button.
        compose.onNodeWithTag("PRODUCT_SCANNER").assertIsDisplayed()
        waitForTag("READY_TO_SCAN")
        compose.onNodeWithTag("READY_TO_SCAN").assertIsDisplayed()
        compose.onNodeWithText("READY TO SCAN").assertIsDisplayed()
        compose.onNodeWithText("CT40").assertIsDisplayed()
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").assertIsDisplayed()
        compose.onAllNodesWithText("Hardware Scanner").assertCountEquals(0)
        compose.onAllNodesWithText("Use the CT40 side trigger — no screen button needed.").assertCountEquals(0)

        // …and NO tool surface, no big scan-button cluster (§20/§29).
        compose.onAllNodesWithTag("OCR_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)

        // 2. Side tools -> drawer with icon + short label items only.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_QR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_OCR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_MANUAL").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_CT40").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_CLOSE").assertIsDisplayed()

        // 3. OCR opens, and the drawer closes itself.
        compose.onNodeWithTag("TOOL_OCR").performClick()
        waitForTag("OCR_SCAN")
        compose.onNodeWithTag("OCR_SCAN").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_BACK").assertIsDisplayed()
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithText("OCR CAPTURE").assertCountEquals(0)
        compose.onAllNodesWithText("READING… keep the SKU line inside the strip").assertCountEquals(0)
        compose.onAllNodesWithText("CLOSE TOOL").assertCountEquals(0)

        // 7. Closing the tool returns to the hardware default.
        compose.onNodeWithTag("TOOL_BACK").performClick()
        waitForTag("READY_TO_SCAN")
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").assertIsDisplayed()

        // 8. QR / BARCODE from the drawer — a tool, never the default.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_QR").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("CAPTURE_QR_AREA").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("CAPTURE_QR_AREA").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_BACK").assertIsDisplayed()
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(0)
        compose.onAllNodesWithText("QR / BARCODE").assertCountEquals(0)
        compose.onAllNodesWithText("CLOSE TOOL").assertCountEquals(0)

        // 11. Manual fallback, then CT40 puts the hardware scanner back in front.
        compose.onNodeWithTag("TOOL_BACK").performClick()
        waitForTag("READY_TO_SCAN")
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_MANUAL").performClick()
        waitForTag("MANUAL_SCAN")
        compose.onNodeWithTag("MANUAL_SCAN").assertIsDisplayed()

        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_CT40").performClick()
        waitForTag("READY_TO_SCAN")
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
    }

    /** The same component serves the CARTON lane (§26) — one scanner UX, two lanes. */
    @Test
    fun cartonLaneUsesTheSameUnifiedScanner() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        forceHardwareScanner = true)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_CARTON_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.CARTON_SCAN }

        compose.onNodeWithTag("CARTON_SCANNER").assertIsDisplayed()
        waitForTag("READY_TO_SCAN")
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").assertIsDisplayed()
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_CLOSE").performClick()
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
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
                        forceHardwareScanner = true)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.PRODUCT_SCAN }
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
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {})
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.PRODUCT_SCAN }
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

        // The drawer offers the camera/manual tools — no CT40 row on a phone.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_QR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_OCR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_MANUAL").assertIsDisplayed()
        compose.onAllNodesWithTag("TOOL_CT40").assertCountEquals(0)
        compose.onNodeWithTag("TOOL_CLOSE").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").fetchSemanticsNodes().isEmpty() }
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
                        forceHardwareScanner = true)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.PRODUCT_SCAN }
        waitForTag("READY_TO_SCAN")
        compose.onAllNodesWithTag("LAST_SCAN").assertCountEquals(0)

        compose.runOnIdle { model.workflow.scan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        // Phase B: the green MATCH flash re-arms the lane BY ITSELF (~250ms)
        // — zero-touch. No BACK press exists on the success verdict anymore.
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForTag("READY_TO_SCAN")

        compose.onNodeWithTag("LAST_SCAN").assertIsDisplayed()
        compose.onNodeWithText("SKU-TEST").assertIsDisplayed()
    }
}
