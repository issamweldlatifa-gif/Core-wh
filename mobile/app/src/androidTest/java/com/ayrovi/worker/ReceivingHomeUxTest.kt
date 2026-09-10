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
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import com.ayrovi.worker.scanner.WorkerDevice
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * RECEIVING UX order — the home screen is two tiles + BACK, and each tile
 * opens its own scanner directly (no intermediate page, no scanner picker,
 * no scan button). Business logic is untouched; this only pins the UX.
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
                        device = WorkerDevice.CT40)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        return model
    }

    @Test
    fun homeShowsOnlyTitleTilesAndBack() {
        openHome()

        // Header stays: AYROVI + ONLINE + the RECEIVING line.
        compose.onNodeWithText("AYROVI").assertIsDisplayed()
        compose.onNodeWithText("ONLINE").assertIsDisplayed()
        compose.onNodeWithText("RECEIVING · REC-01").assertIsDisplayed()

        // Main: the two big CT40-friendly tiles.
        compose.onNodeWithTag("RECEIVING_HOME").assertIsDisplayed()
        compose.onNodeWithText("RECEIVING").assertIsDisplayed()
        compose.onNodeWithTag("HOME_PRODUCT_TILE").assertIsDisplayed()
            .assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithTag("HOME_CARTON_TILE").assertIsDisplayed()
            .assertHeightIsAtLeast(TerminalTokens.touch)

        // Bottom: BACK is the only action.
        compose.onNodeWithText("BACK").assertIsDisplayed()

        // Nothing else: no scanner, no scan/tool buttons, no counters, no lists.
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("PRODUCT_SCANNER").assertCountEquals(0)
        compose.onAllNodesWithTag("CARTON_SCANNER").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_ARROW").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithTag("OCR_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)
        compose.onAllNodesWithText("SCAN").assertCountEquals(0)
        compose.onAllNodesWithText("OCR").assertCountEquals(0)
        compose.onAllNodesWithText("MANUAL").assertCountEquals(0)
        compose.onAllNodesWithText("REFRESH").assertCountEquals(0)
        compose.onAllNodesWithText("CARDS").assertCountEquals(0)
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
    fun tilesOpenTheirScannersDirectlyAndLaneBackReturnsHome() {
        val model = openHome()

        // PRODUCT -> ProductScanner, immediately.
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.PRODUCT_SCAN }
        compose.onNodeWithTag("PRODUCT_SCANNER").assertIsDisplayed()
        compose.onAllNodesWithTag("RECEIVING_HOME").assertCountEquals(0)

        // Lane BACK -> the two tiles, without touching any completed work.
        compose.onNodeWithText("BACK TO RECEIVING").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.HOME }
        compose.onNodeWithTag("RECEIVING_HOME").assertIsDisplayed()

        // CARTON -> CartonScanner, immediately.
        compose.onNodeWithTag("HOME_CARTON_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == HomeStep.CARTON_SCAN }
        compose.onNodeWithTag("CARTON_SCANNER").assertIsDisplayed()
        compose.onAllNodesWithTag("PRODUCT_SCANNER").assertCountEquals(0)
    }
}
