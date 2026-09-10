package com.ayrovi.worker

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.ayrovi.worker.data.OpArticle
import com.ayrovi.worker.data.SortingResult
import com.ayrovi.worker.data.SortingStoreResult
import com.ayrovi.worker.data.SortingZone
import com.ayrovi.worker.data.FlashView
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.presentation.SortingScreen
import com.ayrovi.worker.presentation.SortingStep
import com.ayrovi.worker.presentation.SortingViewModel
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import org.junit.Rule
import org.junit.Test

/**
 * CUSTOMER SORTING native station (station 3 of the Zebra-class build order):
 * zero-touch loop (location scan = STORED, green flash auto re-arms),
 * persistent stop verdicts, and the shared GLARE BOOST sun.
 * No production service is contacted — the gateway is an in-memory fixture.
 */
class SortingUiTest {

    @get:Rule
    val compose = createComposeRule()

    private class FakeSortingGateway : com.ayrovi.worker.presentation.SortingGateway {
        var stores = 0
        override suspend fun scan(articleCode: String): SortingResult =
            if (articleCode.equals("ART-OK", ignoreCase = true)) SortingResult(
                kind = "DESTINATION",
                article = OpArticle(code = "A-1", sku = "ART-OK", productName = "UI FIXTURE ARTICLE"),
                zone = SortingZone(code = "Z-3", name = "Aisle 3"),
                suggestedLocations = listOf("Z3-A1", "Z3-A2"),
            ) else SortingResult(kind = "REJECTED", reason = "UNKNOWN ARTICLE")
        override suspend fun store(articleCode: String, locationCode: String): SortingStoreResult =
            if (locationCode.equals("Z3-A1", ignoreCase = true)) {
                stores += 1
                SortingStoreResult(flash = FlashView(kind = "STORED", cardType = "SORTING", code = locationCode, sku = articleCode, message = "Stored"))
            } else SortingStoreResult()
    }

    private lateinit var model: SortingViewModel
    private val gateway = FakeSortingGateway()
    private var glare = false

    private fun openSorting() {
        glare = false
        model = SortingViewModel(gateway)
        compose.setContent {
            LaunchedEffect(Unit) { model.setForeground(true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    SortingScreen(
                        model = model, worker = "W-001 · UI TEST FIXTURE", station = "ST-SRT-01",
                        connection = "ONLINE", onBack = {}, industrial = true,
                        repository = null, appVersion = "ui-test", deviceCode = "DEV-TEST",
                        onToggleTheme = {}, forceHardwareScanner = true,
                        glareOn = glare, onToggleGlare = { glare = !glare },
                    )
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCANNER_PANEL").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun sortingLoopIsZeroTouchAndStopVerdictsPersist() {
        openSorting()
        compose.onNodeWithTag("GLARE_BUTTON").assertIsDisplayed()
        waitForTag("READY_TO_SCAN")

        // STEP 1: a known article reveals the destination (guidance, no overlay).
        compose.runOnIdle { model.onScan(ScanResult("ART-OK", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("DESTINATION_PANEL")
        compose.onAllNodesWithTag("SCAN_RESULT").assertCountEquals(0)

        // STEP 2: the location scan IS the confirmation. The green flash is a
        // ~250ms window — assert the OUTCOME (state re-armed, unit stored)
        // instead of racing the flash, then the READY panel.
        compose.runOnIdle { model.onScan(ScanResult("Z3-A1", ScanSource.EXTERNAL_SCANNER)) }
        compose.waitUntil(10_000) {
            model.state.value.stored == 1 && model.state.value.step == SortingStep.ARTICLE
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForTag("READY_TO_SCAN")

        // A rejected article stays full-bleed RED until BACK — never auto-dismissed.
        compose.runOnIdle { model.onScan(ScanResult("ART-BAD", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        Thread.sleep(1_500)
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()
        compose.onNodeWithTag("RESULT_BACK").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
    }
}
