package com.ayrovi.worker

import android.Manifest
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.rule.GrantPermissionRule
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.presentation.TempStorageScreen
import com.ayrovi.worker.presentation.TempStorageViewModel
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
import com.ayrovi.worker.scanner.WorkerDevice
import org.junit.Rule
import org.junit.Test

/**
 * MASTER ORDER §§14–§35 on the TEMPORARY STORAGE station — the unified scanner
 * must be applied there "for real" (§25/§33), on the same CT40 layout, with the
 * same rules as Receiving:
 *
 *  · the screen opens on READY TO SCAN + CT40 indication + the ONE small side
 *    tools button — never a tool list (§29);
 *  · the side button stays reachable while a tool is open, so returning to the
 *    CT40 hardware default is one small tap (§18/§19/§31);
 *  · a CT40 trigger read closes the tool and the verdict stays in the foreground
 *    until BACK, SUCCESS as well as ERROR (§21/§27/§28).
 */
class UnifiedScannerTsUiTest {

    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val camera: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    private lateinit var model: TempStorageViewModel

    private fun openTempStorage() {
        model = TempStorageViewModel(TsUiGateway(), setOf("receiving.execute"))
        val repository = uiRepository()
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.execute"), true, ConnectionState.ONLINE) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    TempStorageScreen(
                        model = model,
                        worker = "W-001 · UI TEST FIXTURE",
                        station = "ST-TS-01",
                        connection = "ONLINE",
                        onBack = {},
                        onAuthExpired = {},
                        industrial = true,
                        repository = repository,
                        appVersion = "ui-test",
                        deviceCode = "DEV-TEST",
                        device = WorkerDevice.CT40,
                        onToggleTheme = {},
                    )
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
    }

    private fun waitForTag(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }

    private fun waitForTagGone(tag: String) =
        compose.waitUntil(10_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }

    @Test
    fun tempStorageOpensOnReadyToScanAndKeepsToolsInTheDrawer() {
        openTempStorage()

        // The station board is the work interface and the scanner starts armed.
        compose.onAllNodesWithTag("TS_SECTION_A").assertCountEquals(1)
        waitForTag("READY_TO_SCAN")
        // The station home lists the sections above the scanner, so the panel is
        // scrolled into view exactly like the operator would see it.
        compose.onNodeWithTag("READY_TO_SCAN").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("READY TO SCAN").assertIsDisplayed()
        compose.onNodeWithText("CT40").assertIsDisplayed()

        // §16/§31: ONE small side button, finger-sized touch target.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performScrollTo().assertIsDisplayed()
            .assertHeightIsAtLeast(TerminalTokens.touch)
            .assertWidthIsAtLeast(TerminalTokens.touch)

        // §29: no tool is on the screen before the drawer is asked for.
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("OCR_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)

        // §17/§18: the drawer is the ONLY way to the other read methods.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performScrollTo().performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_QR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_OCR").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_MANUAL").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_CT40").assertIsDisplayed()
        compose.onNodeWithTag("TOOL_CLOSE").assertIsDisplayed()
        // The work interface is still behind the drawer — it is an overlay, the
        // station board is not replaced and nothing important is covered.
        compose.onAllNodesWithTag("TS_SECTION_A").assertCountEquals(1)

        // §18: picking a tool closes the drawer and opens the tool.
        compose.onNodeWithTag("TOOL_MANUAL").performClick()
        waitForTag("MANUAL_SCAN")
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)

        // §19/§31: back to the CT40 hardware default in ONE small tap, without
        // closing the tool first — the side button stays reachable.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performScrollTo().performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_CT40").performClick()
        waitForTag("READY_TO_SCAN")
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)

        // §18: FERMER alone closes the drawer without changing the scanner state.
        compose.onNodeWithTag("SCAN_TOOLS_ARROW").performScrollTo().performClick()
        waitForTag("SCAN_TOOLS_DRAWER")
        compose.onNodeWithTag("TOOL_CLOSE").performClick()
        waitForTagGone("SCAN_TOOLS_DRAWER")
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(1)
    }

    @Test
    fun hardwareScanStoresAndTheVerdictWaitsForBack() {
        openTempStorage()

        // CT40 trigger read of a confirmed product: the station resolves the
        // target container and the board opens on that section.
        compose.runOnIdle { model.onScan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("TS_TARGET_CONT-TEST")
        compose.onAllNodesWithTag("TS_TARGET_CONT-TEST").assertCountEquals(1)

        // CT40 trigger read of the container: stored -> SUCCESS verdict.
        compose.runOnIdle { model.onScan(ScanResult("CONT-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("SCAN_RESULT")
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()
        compose.onAllNodesWithTag("MANUAL_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("CAPTURE_QR_AREA").assertCountEquals(0)

        // §27: no auto-dismiss — still in the foreground after the old timer.
        Thread.sleep(3_000)
        compose.waitForIdle()
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()

        compose.onNodeWithTag("RESULT_BACK").performClick()
        waitForTagGone("SCAN_RESULT")
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(1)
    }

    @Test
    fun wrongContainerShowsAnErrorVerdictThatAlsoWaitsForBack() {
        openTempStorage()

        compose.runOnIdle { model.onScan(ScanResult("SKU-TEST", ScanSource.EXTERNAL_SCANNER)) }
        waitForTag("TS_TARGET_CONT-TEST")
        compose.runOnIdle { model.onScan(ScanResult("CONT-WRONG", ScanSource.EXTERNAL_SCANNER)) }

        waitForTag("SCAN_RESULT")
        compose.onNodeWithText("WRONG CONTAINER").assertIsDisplayed()
        Thread.sleep(3_000)
        compose.waitForIdle()
        compose.onNodeWithTag("SCAN_RESULT").assertIsDisplayed()

        compose.onNodeWithTag("RESULT_BACK").performClick()
        waitForTagGone("SCAN_RESULT")
        // Nothing was stored: the station is still asking for the right container.
        compose.onAllNodesWithTag("TS_TARGET_CONT-TEST").assertCountEquals(1)
    }
}
