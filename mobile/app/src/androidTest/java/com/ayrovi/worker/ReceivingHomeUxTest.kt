package com.ayrovi.worker

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.presentation.ReceivingHomeIntent
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import com.ayrovi.worker.scanner.WorkerDevice
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * UX CORRECTION acceptance (§13) — RECEIVING is INFORMATION ONLY and the
 * scan tools open their existing scanner/OCR directly from Home:
 *
 * TEST 1 — Receiving shows cards/statuses ONLY (no product/carton screens,
 *          no scanner, no camera, no scan button, no report shortcut).
 * TEST 2 — QR CODE opens the existing scanner DIRECTLY (AUTO tool), with no
 *          intermediate screen.
 * TEST 4 — the Settings icon is NOT in the header (Settings lives on Home).
 */
class ReceivingHomeUxTest {

    @get:Rule
    val compose = createComposeRule()

    private fun openHome(onBack: () -> Unit = {}): ReceivingHomeViewModel {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", onBack, {},
                        device = WorkerDevice.CT40, autoOpenCamera = false)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        return model
    }

    @Test
    fun test1_receivingShowsCardsAndStatusesOnly() {
        val model = openHome()
        // Hardened: wait for the DATA (the home feed) before asserting the
        // UI — the state flow and the composition are two different clocks.
        compose.waitUntil(10_000) { model.state.value.home?.productCards?.isNotEmpty() == true }

        // Header stays: AYROVI + ONLINE + the RECEIVING line.
        compose.onNodeWithText("AYROVI").assertIsDisplayed()
        compose.onNodeWithText("ONLINE").assertIsDisplayed()
        compose.onNodeWithText("RECEIVING · REC-01").assertIsDisplayed()

        // The overview content: TO DO group with the dispatched cards.
        compose.onNodeWithTag("RECEIVING_HOME").assertIsDisplayed()
        compose.onNodeWithTag("RECEIVING_TODO").assertExists()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("RECEIVING_CARD_PRODUCT_FIRST").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("RECEIVING_CARD_PRODUCT_FIRST").assertExists()
        compose.onNodeWithTag("RECEIVING_CARD_CARTON_FIRST").assertExists()
        compose.onNodeWithText("BACK").assertIsDisplayed()

        // NOT expected (§2): no product/carton selection, no scanner, no
        // camera surface, no scan tools, and no report shortcut on Receiving.
        compose.onAllNodesWithTag("HOME_PRODUCT_TILE").assertCountEquals(0)
        compose.onAllNodesWithTag("HOME_CARTON_TILE").assertCountEquals(0)
        compose.onAllNodesWithTag("HOME_REPORT_BUTTON").assertCountEquals(0)
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("PRODUCT_SCANNER").assertCountEquals(0)
        compose.onAllNodesWithTag("CARTON_SCANNER").assertCountEquals(0)
        compose.onAllNodesWithTag("AUTO_SCANNER").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_ARROW").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithTag("OCR_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
        compose.onAllNodesWithText("SCAN PRODUCT OR CARTON").assertCountEquals(0)
    }

    @Test
    fun backLeavesReceivingForThePreviousScreen() {
        var backPressed = false
        openHome(onBack = { backPressed = true })
        compose.onNodeWithText("BACK").performClick()
        compose.waitUntil(10_000) { backPressed }
        assertTrue(backPressed)
    }

    @Test
    fun test2_qrToolOpensTheScannerDirectly() {
        // HOME → QR CODE → the existing unified scanner opens DIRECTLY (the
        // AUTO tool): no Receiving, no Product, no Carton, no scan selection.
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        var backPressed = false
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", { backPressed = true }, {},
                        device = WorkerDevice.CT40, openWith = ReceivingHomeIntent.OpenAutoScan,
                        autoOpenCamera = false, forceHardwareScanner = true)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.AUTO_SCAN }
        compose.onNodeWithTag("AUTO_SCANNER").assertIsDisplayed()
        compose.onAllNodesWithTag("RECEIVING_HOME").assertCountEquals(0)
        // ONE back rule: BACK from the tool fires the MAIN-home back — no
        // detour through the Receiving overview, no extra confirmation.
        compose.onNodeWithText("BACK").performClick()
        compose.waitUntil(10_000) { backPressed }
        assertTrue(backPressed)
    }

    @Test
    fun gloveModeKeepsTheOverviewReachable() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}, gloveMode = true) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        device = WorkerDevice.CT40, autoOpenCamera = false)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.waitUntil(10_000) { model.state.value.home?.productCards?.isNotEmpty() == true }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("RECEIVING_CARD_PRODUCT_FIRST").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("RECEIVING_CARD_PRODUCT_FIRST").assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithTag("RECEIVING_CARD_CARTON_FIRST").assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithText("BACK").assertHeightIsAtLeast(64.dp)
    }
}
