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
import com.ayrovi.worker.data.OpArticle
import com.ayrovi.worker.data.OpOrderRef
import com.ayrovi.worker.data.BinRef
import com.ayrovi.worker.data.ShipResult
import com.ayrovi.worker.data.ShipmentView
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.presentation.ShippingScreen
import com.ayrovi.worker.presentation.ShippingViewModel
import com.ayrovi.worker.presentation.ShippingGateway
import com.ayrovi.worker.presentation.TraceScreen
import com.ayrovi.worker.presentation.TraceViewModel
import com.ayrovi.worker.presentation.TraceGateway
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import org.junit.Rule
import org.junit.Test

/**
 * SHIPPING + TRACE native stations (station 5 of the Zebra-class build
 * order). Shipping keeps the ONE deliberate confirm (dispatch is
 * irreversible); an already-shipped label is a persistent amber verdict.
 * Trace is a read-only chain lookup. In-memory gateways only.
 */
class ShippingTraceUiTest {

    @get:Rule
    val compose = createComposeRule()

    private class FakeShippingGateway : ShippingGateway {
        var shipped = 0
        override suspend fun scan(code: String): ShipmentView {
            val already = code.equals("OUT-DONE", ignoreCase = true)
            return ShipmentView(
                code = code.uppercase(), status = if (already) "SHIPPED" else "READY",
                carrier = "internal", trackingNumber = "TRK-1",
                order = OpOrderRef(externalCustomerReference = "UI FIXTURE CUSTOMER", externalOrderReference = "ORD-9"),
                articles = listOf(OpArticle(code = "A-1", sku = "SKU-A", productName = "Item A")),
                container = BinRef(code = "BIN-1"),
            )
        }
        override suspend fun ship(code: String): ShipResult {
            shipped += 1
            return ShipResult()
        }
    }

    private class FakeTraceGateway : TraceGateway {
        override suspend fun trace(code: String): com.ayrovi.worker.data.TraceView {
            if (code.equals("SKU-404", ignoreCase = true)) {
                throw com.ayrovi.worker.data.WorkerRepository.ApiException(404, "No chain for $code")
            }
            return com.ayrovi.worker.data.TraceView(
                article = OpArticle(code = code.uppercase(), sku = code.uppercase(), productName = "Traced item", status = "IN_CONTAINER"),
                trace = com.ayrovi.worker.data.TraceChain(
                    expectedArrival = "ARR-1", receivingSession = "REC-1",
                    container = com.ayrovi.worker.data.TraceContainer(code = "CTN-1", label = "War 1"),
                ),
            )
        }
    }

    private lateinit var ship: ShippingViewModel
    private lateinit var trace: TraceViewModel
    private val shipping = FakeShippingGateway()
    private val tracing = FakeTraceGateway()
    private var glare = false

    private fun openShipping() {
        glare = false
        ship = ShippingViewModel(shipping)
        compose.setContent {
            LaunchedEffect(Unit) { ship.setForeground(true); ship.setAvailable(true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ShippingScreen(
                        model = ship, worker = "W-001 · UI TEST FIXTURE", station = "ST-SHP-01",
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

    @Test
    fun shippingRevealsCardsThenConfirmsDispatchAndAlreadyShippedPersists() {
        openShipping()
        compose.onNodeWithTag("GLARE_BUTTON").assertIsDisplayed()

        // Scan a READY shipment: cards + the deliberate confirm (no overlay).
        compose.runOnIdle { ship.onScan(ScanResult("OUT-1", ScanSource.EXTERNAL_SCANNER)) }
        compose.waitUntil(10_000) { ship.state.value.view?.code == "OUT-1" }
        compose.onNodeWithTag("SHIPMENT_PANEL").assertIsDisplayed()
        compose.onNodeWithTag("CONFIRM_DISPATCH").assertIsDisplayed()

        // The deliberate confirmation ships it and re-arms the scanner.
        compose.onNodeWithTag("CONFIRM_DISPATCH").performClick()
        compose.waitUntil(10_000) { ship.state.value.shippedToday == 1 }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
        waitForScanner()

        // An already-shipped label is a persistent amber verdict until BACK.
        compose.runOnIdle { ship.onScan(ScanResult("OUT-DONE", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        Thread.sleep(1_500)
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()
        compose.onNodeWithTag("RESULT_BACK").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun traceShowsTheChainWithoutWritingAnything() {
        trace = TraceViewModel(tracing)
        compose.setContent {
            LaunchedEffect(Unit) { trace.setForeground(true); trace.setAvailable(true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    TraceScreen(
                        model = trace, worker = "W-001 · UI TEST FIXTURE", station = "ST-SHP-01",
                        connection = "ONLINE", onBack = {}, industrial = true,
                        repository = null, appVersion = "ui-test", deviceCode = "DEV-TEST",
                        onToggleTheme = {}, forceHardwareScanner = true,
                        glareOn = false, onToggleGlare = {},
                    )
                }
            }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCANNER_PANEL").fetchSemanticsNodes().isNotEmpty() }

        compose.runOnIdle { trace.onScan(ScanResult("SKU-77", ScanSource.EXTERNAL_SCANNER)) }
        // Outcome first (state), then the panel — assertExists dumps the full
        // semantics tree on failure, giving the layout answer in one CI cycle.
        compose.waitUntil(10_000) { trace.state.value.view != null }
        compose.onNodeWithTag("TRACE_PANEL").assertExists()

        // A failed lookup is a persistent verdict until BACK.
        compose.runOnIdle { trace.onScan(ScanResult("SKU-404", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        compose.onNodeWithTag("RESULT_BACK").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCAN_RESULT").fetchSemanticsNodes().isEmpty() }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForScanner() =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("SCANNER_PANEL").fetchSemanticsNodes().isNotEmpty() }
}
