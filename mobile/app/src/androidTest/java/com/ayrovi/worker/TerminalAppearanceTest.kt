package com.ayrovi.worker

import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.data.*
import com.ayrovi.worker.design.*
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import com.ayrovi.worker.presentation.WorkerSettingsDialog
import com.ayrovi.worker.scanner.WorkerDevice
import java.util.UUID
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Actual native Compose UI; fixture gateway in androidTest ONLY. No production API is contacted. */
@RunWith(AndroidJUnit4::class)
class TerminalAppearanceTest {
    @get:Rule val compose = createComposeRule()

    @Test fun bothPalettesMeetTextAndControlContrast() {
        for (palette in listOf(TerminalPalette.White, TerminalPalette.Black)) {
            for (text in listOf(palette.text, palette.muted, palette.instruction, palette.success, palette.warning, palette.error)) {
                assertTrue("Text on surface needs 4.5:1", contrast(text, palette.surface) >= 4.5)
                assertTrue("Text on background needs 4.5:1", contrast(text, palette.background) >= 4.5)
            }
            assertTrue(contrast(palette.primary, palette.onPrimary) >= 4.5)
            assertTrue(contrast(palette.error, palette.onError) >= 4.5)
            assertTrue("Panel boundaries need 3:1", contrast(palette.border, palette.surface) >= 3.0)
        }
        assertEquals(Color.White, TerminalPalette.White.background)
        assertEquals(Color.Black, TerminalPalette.Black.background)
    }

    @Test fun displayPreferencePersistsWithoutTouchingSessionData() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = "appearance_test_${UUID.randomUUID()}"
        try {
            val preferences = TerminalPreferences(context, file)
            assertEquals(TerminalThemeMode.WHITE, preferences.theme.value)
            assertTrue(preferences.selectTheme(TerminalThemeMode.BLACK))
            assertEquals(TerminalThemeMode.BLACK, TerminalPreferences(context, file).theme.value)
            assertEquals(setOf("contrast_mode"), context.getSharedPreferences(file, Context.MODE_PRIVATE).all.keys)
            assertTrue(preferences.selectTheme(TerminalThemeMode.WHITE))
            assertEquals(TerminalThemeMode.WHITE, TerminalPreferences(context, file).theme.value)
        } finally { context.deleteSharedPreferences(file) }
    }

    @Test fun receivingHomeShowsTwoTilesAndBackOnlyThenOpensProductScanner() {
        val backend = ReceivingUiGateway()
        val model = ReceivingHomeViewModel(backend, "worker", setOf("receiving.view", "receiving.execute"))
        var mode by mutableStateOf(TerminalThemeMode.WHITE)
        var observedBackground: Color? = null
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(mode, onToggleTheme = { mode = mode.next() }) {
                    observedBackground = TerminalTokens.background
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        device = WorkerDevice.PHONE, onToggleTheme = { mode = mode.next() })
                }
            }
        }
        // RECEIVING opens the WORK CENTER (not the scanner): title + card
        // content + two tiles + BACK. UX RESTRUCTURE: Settings is NOT in the
        // header anymore — its one entry point is the Home screen.
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("RECEIVING_HOME").assertExists()
        compose.onNodeWithText("RECEIVING").assertIsDisplayed()
        compose.onAllNodesWithText("PRODUCT").onFirst().assertExists()
        compose.onAllNodesWithText("CARTON").onFirst().assertExists()
        compose.onNodeWithContentDescription("Worker and settings").assertDoesNotExist()
        compose.onNodeWithTag("HOME_PRODUCT_TILE").assertExists()
            .assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithTag("HOME_CARTON_TILE").assertExists()
            .assertHeightIsAtLeast(TerminalTokens.touch)
        // …and no scanner while the work center is open.
        compose.onAllNodesWithTag("READY_TO_SCAN").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_ARROW").assertCountEquals(0)
        compose.onAllNodesWithTag("SCAN_TOOLS_DRAWER").assertCountEquals(0)
        compose.onAllNodesWithText("SCAN PRODUIT").assertCountEquals(0)
        compose.onAllNodesWithText("SCAN CARTON").assertCountEquals(0)
        compose.onAllNodesWithText("CONFIRMATION REPORT").assertCountEquals(0)
        saveScreenshot("receiving-home-white")
        // PRODUCT opens the PRODUCT scanner directly (no intermediate page).
        compose.onNodeWithTag("HOME_PRODUCT_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == com.ayrovi.worker.domain.HomeStep.PRODUCT_SCAN }
        compose.onNodeWithTag("PRODUCT_SCANNER").assertIsDisplayed()
        saveScreenshot("receiving-product-scanner-black")
    }

    @Test fun changeDisplaySwitchesPaletteThroughTheSettingsDialog() {
        // UX RESTRUCTURE §4/§16: CHANGE DISPLAY moved INTO Settings (Home →
        // SETTINGS). The palette switch behavior itself is unchanged.
        var mode by mutableStateOf(TerminalThemeMode.WHITE)
        var observedBackground: Color? = null
        compose.setContent {
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(mode, onToggleTheme = { mode = mode.next() }) {
                    observedBackground = TerminalTokens.background
                    WorkerSettingsDialog(repository = null, worker = "W-001 · UI TEST FIXTURE", station = "REC-01",
                        connection = "ONLINE", appVersion = "test", deviceCode = "TEST-CODE",
                        device = WorkerDevice.PHONE, onSwitchMode = {}, onClose = {},
                        onChangeDisplay = { mode = mode.next() })
                }
            }
        }
        compose.waitUntil(10_000) { observedBackground != null }
        val before = observedBackground
        compose.onNodeWithText("CHANGE DISPLAY").performClick()
        compose.waitUntil(10_000) { observedBackground != before }
        compose.runOnIdle { assertEquals(Color.Black, observedBackground) }
    }

    @Test fun cartonScanOpensDedicatedCartonScannerAtLargeFont() {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 1.5f)) {
                Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                    AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                        ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {})
                    }
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithTag("HOME_CARTON_TILE").performScrollTo().assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithTag("HOME_CARTON_TILE").performClick()
        compose.waitUntil(10_000) { model.state.value.step == com.ayrovi.worker.domain.HomeStep.CARTON_SCAN }
        compose.onNodeWithTag("CARTON_SCANNER").assertIsDisplayed()
        saveScreenshot("receiving-carton-scanner-large-font")
    }

    private fun saveScreenshot(name: String) = saveNativeScreenshot(compose, name)
    private fun contrast(a: Color, b: Color): Float {
        val first = a.luminance(); val second = b.luminance()
        return (maxOf(first, second) + .05f) / (minOf(first, second) + .05f)
    }
}
