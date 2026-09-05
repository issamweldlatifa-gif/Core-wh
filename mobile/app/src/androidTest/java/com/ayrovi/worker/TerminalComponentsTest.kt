package com.ayrovi.worker

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.ayrovi.worker.design.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Emulator/UI checks are separate from enterprise trigger or physical device acceptance. */
@RunWith(AndroidJUnit4::class)
class TerminalComponentsTest {
    @get:Rule val compose = createComposeRule()
    @Test fun primaryControlHasGlovedTouchHeightAndExplicitDisabledState() {
        compose.setContent { AyroviTerminalTheme { PrimaryAction("CONFIRM 1 ARTICLE", {}, enabled = false) } }
        compose.onNodeWithText("CONFIRM 1 ARTICLE").assertIsNotEnabled().assertHeightIsAtLeast(TerminalTokens.primaryTouch)
    }
    @Test fun errorsHaveMeaningAndScannedExpectedContextNotJustColor() {
        compose.setContent { AyroviTerminalTheme { ErrorState("WRONG CARTON", "This carton belongs to another shipment.", "SHP-001", "CTN-OTHER") } }
        compose.onNodeWithText("This carton belongs to another shipment.").assertIsDisplayed()
        compose.onNodeWithText("SHP-001").assertIsDisplayed()
        compose.onNodeWithText("CTN-OTHER").assertIsDisplayed()
    }
    @Test fun criticalTextSupportsIncreasedFontScale() {
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 1.5f)) {
                AyroviTerminalTheme {
                    Column {
                        TaskInstruction("SCAN PRODUCT")
                        ProductBlock("Heavy duty warehouse component", "Sku/Long-000001")
                        PrimaryAction("CONFIRM 1 ARTICLE", {})
                    }
                }
            }
        }
        compose.onNodeWithText("SCAN PRODUCT").assertIsDisplayed()
        compose.onNodeWithText("Sku/Long-000001").assertIsDisplayed()
        compose.onNodeWithText("CONFIRM 1 ARTICLE").assertHeightIsAtLeast(TerminalTokens.primaryTouch)
    }
}
