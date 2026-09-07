package com.ayrovi.worker

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.ayrovi.worker.data.*
import com.ayrovi.worker.design.*
import com.ayrovi.worker.presentation.ReceivingScreen
import com.ayrovi.worker.presentation.ReceivingViewModel
import java.io.File
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

    @Test fun whiteBlackToggleAndModeControlsKeepTheSameWorkflow() {
        val backend = ReceivingUiGateway()
        val model = ReceivingViewModel(backend, EmptyJournal, "worker", setOf("receiving.view", "receiving.execute"))
        var mode by mutableStateOf(TerminalThemeMode.WHITE)
        var observedBackground: Color? = null
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true, "session") }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(mode, onToggleTheme = { mode = mode.next() }) {
                    observedBackground = TerminalTokens.background
                    ReceivingScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {}, {}, onToggleTheme = { mode = mode.next() })
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithText("CARTON").assertIsSelected().assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithContentDescription("Back to work queue").assertIsDisplayed().assertHeightIsAtLeast(TerminalTokens.touch)
        saveScreenshot("receiving-white")
        compose.onNodeWithContentDescription("Worker and settings").performClick()
        compose.onNodeWithText("CHANGE DISPLAY").performClick()
        compose.runOnIdle { assertEquals(Color.Black, observedBackground) }
        compose.onNodeWithText("CLOSE").performClick()
        saveScreenshot("receiving-black")
        compose.onNodeWithText("PRODUIT").performClick()
        compose.waitUntil(10_000) { model.state.value.mode == com.ayrovi.worker.domain.ReceivingMode.PRODUCTS && !model.state.value.busy }
        compose.onNodeWithText("PRODUIT").assertIsSelected()
        compose.onNodeWithText("SCAN PRODUCT").assertExists()
        compose.runOnIdle { assertEquals(0, backend.writes); assertEquals("session", model.state.value.session!!.id) }
        saveScreenshot("receiving-product-mode-black")
    }

    @Test fun handheldAtLargeFontKeepsModeBackAndPrimaryActionReachable() {
        val model = ReceivingViewModel(ReceivingUiGateway(), EmptyJournal, "worker", setOf("receiving.view", "receiving.execute"))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true, "session") }
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 1.5f)) {
                Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                    AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                        ReceivingScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {}, {})
                    }
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
        compose.onNodeWithText("CARTON").assertIsDisplayed().assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithText("PRODUIT").assertIsDisplayed().assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithContentDescription("Back to work queue").assertIsDisplayed()
        compose.onNodeWithText("TASK ACTIONS").assertIsDisplayed().assertHeightIsAtLeast(TerminalTokens.touch)
        compose.onNodeWithText("SOFTWARE SCAN").performScrollTo().assertHeightIsAtLeast(TerminalTokens.primaryTouch)
        saveScreenshot("receiving-white-large-font")
    }

    private fun saveScreenshot(name: String) = saveNativeScreenshot(compose, name)
    private fun contrast(a: Color, b: Color): Float {
        val first = a.luminance(); val second = b.luminance()
        return (maxOf(first, second) + .05f) / (minOf(first, second) + .05f)
    }

    private object EmptyJournal : MutationJournal {
        override fun read(): PendingMutation? = null
        override fun record(mutation: PendingMutation) = error("UI appearance tests must not dispatch writes")
        override fun clear(id: String) = Unit
    }

}
