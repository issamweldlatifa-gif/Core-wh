package com.ayrovi.worker

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.presentation.PrinterScreen
import com.ayrovi.worker.printer.PrinterRuntime
import org.junit.Rule
import org.junit.Test

/**
 * The CT40 printer screen (owner order 2026-09-16) renders the REAL printer
 * stack — [PrinterRuntime] built on the device context, the same manager the
 * bridge service drives. It must compose and answer the obvious questions
 * without a printer attached: what the link state is, how to search, and
 * whether the web bridge is up (or why it is not).
 *
 * No printer is involved: the emulator has none, and this test never taps
 * SEARCH (that would ask a radio that is not there). It is the composition
 * net the other screens already have — BatchTilesUxTest exists because a
 * missing one shipped a crash to the floor.
 */
class PrinterScreenUxTest {

    @get:Rule
    val compose = createComposeRule()

    private fun render(bridgeRunning: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runtime = PrinterRuntime.of(context)
        compose.setContent {
            AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                PrinterScreen(
                    runtime = runtime,
                    worker = "W-001 · UI TEST FIXTURE",
                    station = "ST-REC-01",
                    connection = "ONLINE",
                    industrial = true,
                    agentPrinted = 0,
                    bridgeRunning = bridgeRunning,
                    bridgeError = if (bridgeRunning) null else "the local port 8787 is not available",
                    onToggleBridge = {},
                    onBack = {},
                )
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun printer_screen_composes_and_offers_the_search_action() {
        render(bridgeRunning = true)
        // Exact-text matchers: "PRINTER" itself appears twice (header + task
        // instruction), so the assertions below are the unambiguous ones.
        compose.onNodeWithText("NOT CONNECTED").assertIsDisplayed()
        compose.onNodeWithText("SEARCH PRINTERS").assertIsDisplayed()
        compose.onNodeWithText("ADMIN WEB BRIDGE").assertIsDisplayed()
    }

    @Test
    fun a_bridge_that_never_listened_is_shown_as_failed_never_as_running() {
        render(bridgeRunning = false)
        compose.onNodeWithText("FAILED: the local port 8787 is not available").assertIsDisplayed()
    }
}
