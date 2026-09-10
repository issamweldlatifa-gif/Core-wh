package com.ayrovi.worker

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.ayrovi.worker.data.BinRef
import com.ayrovi.worker.data.OpArticle
import com.ayrovi.worker.data.OrderRef
import com.ayrovi.worker.data.PackResult
import com.ayrovi.worker.data.PackResultShipment
import com.ayrovi.worker.data.PackingView
import com.ayrovi.worker.data.RequiredItem
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.presentation.PackingScreen
import com.ayrovi.worker.presentation.PackingViewModel
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import org.junit.Rule
import org.junit.Test

/**
 * PACKING native station (station 4 of the Zebra-class build order):
 * a COMPLETE bin packs immediately (zero-touch, green flash re-arms),
 * an INCOMPLETE bin is a persistent amber verdict, and the shared
 * GLARE BOOST sun lives in the footer. In-memory gateway only.
 */
class PackingUiTest {

    @get:Rule
    val compose = createComposeRule()

    private class FakePackingGateway : com.ayrovi.worker.presentation.PackingGateway {
        var packs = 0
        override suspend fun scan(binCode: String): PackingView {
            val complete = binCode.equals("BIN-OK", ignoreCase = true)
            return PackingView(
                bin = BinRef(code = binCode.uppercase()),
                order = OrderRef(reference = "R-1", customer = "UI FIXTURE CUSTOMER"),
                required = listOf(
                    RequiredItem(sku = "SKU-A", productName = "Item A", requested = 2, inBin = if (complete) 2 else 1),
                    RequiredItem(sku = "SKU-B", productName = "Item B", requested = 1, inBin = if (complete) 1 else 0),
                ),
                articles = emptyList(),
                complete = complete,
            )
        }
        override suspend fun pack(binCode: String): PackResult {
            packs += 1
            return PackResult(shipment = PackResultShipment(code = "SHP-77", labelValue = "LBL-77"))
        }
    }

    private lateinit var model: PackingViewModel
    private val gateway = FakePackingGateway()
    private var glare = false

    private fun openPacking() {
        glare = false
        model = PackingViewModel(gateway)
        compose.setContent {
            LaunchedEffect(Unit) { model.setForeground(true); model.setAvailable(true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    PackingScreen(
                        model = model, worker = "W-001 · UI TEST FIXTURE", station = "ST-PCK-01",
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
    fun packingIsZeroTouchAndIncompleteBinsPersist() {
        openPacking()
        compose.onNodeWithTag("GLARE_BUTTON").assertIsDisplayed()
        waitForTag("READY_TO_SCAN")

        // COMPLETE bin: packed immediately — assert the OUTCOME, not the flash.
        compose.runOnIdle { model.onScan(ScanResult("BIN-OK", ScanSource.EXTERNAL_SCANNER)) }
        compose.waitUntil(10_000) { model.state.value.packedToday == 1 && model.state.value.lastShipment == "SHP-77" }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForTag("READY_TO_SCAN")

        // INCOMPLETE bin: amber verdict persists (never auto-dismissed)…
        compose.runOnIdle { model.onScan(ScanResult("BIN-PART", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        Thread.sleep(1_500)
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()

        // …until BACK.
        compose.onNodeWithTag("RESULT_BACK").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
    }
}
