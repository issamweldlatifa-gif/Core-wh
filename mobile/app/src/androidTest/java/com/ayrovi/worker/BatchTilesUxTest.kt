package com.ayrovi.worker

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.ayrovi.worker.data.BatchCompleteReceivingIn
import com.ayrovi.worker.data.BatchCreateIn
import com.ayrovi.worker.data.BatchCreatedPayload
import com.ayrovi.worker.data.BatchDetailPayload
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.BatchReceiveUnitPayload
import com.ayrovi.worker.data.BatchRowPayload
import com.ayrovi.worker.data.BatchStartedPayload
import com.ayrovi.worker.data.BatchSubmitIn
import com.ayrovi.worker.data.BatchSubmittedPayload
import com.ayrovi.worker.data.BatchUnitAddedPayload
import com.ayrovi.worker.data.BatchUnitIn
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.presentation.BatchReceiveScreen
import com.ayrovi.worker.presentation.BatchReceiveViewModel
import com.ayrovi.worker.presentation.BatchScreen
import com.ayrovi.worker.presentation.BatchViewModel
import org.junit.Rule
import org.junit.Test

/**
 * v72 net for the OWNER-REPORTED crash: tapping the BATCH / BATCH IN tiles
 * exited the app on a real device (v70 shipped the routes without the tiles,
 * so these two screens were never exercised on an Android surface). These
 * tests render BOTH screens with the real BatchViewModel + a fake gateway —
 * the same composition path the terminal uses — and survive interaction.
 * A composition crash here fails loudly in CI with the real stack trace.
 */
class BatchTilesUxTest {

    @get:Rule
    val compose = createComposeRule()

    private val gateway = object : BatchGateway {
        override suspend fun batchCreate(input: BatchCreateIn): BatchCreatedPayload = BatchCreatedPayload(
            batch = BatchRowPayload(id = "b1", batchCode = "AYB-TEST-00001", status = "CREATED",
                totalExpected = 10, totalScanned = 0),
        )
        override suspend fun batchAddUnit(batchId: String, input: BatchUnitIn): BatchUnitAddedPayload =
            BatchUnitAddedPayload()
        override suspend fun batchSubmit(batchId: String, input: BatchSubmitIn): BatchSubmittedPayload =
            BatchSubmittedPayload()
        override suspend fun batchOpen(): List<BatchRowPayload> = listOf(
            BatchRowPayload(id = "b1", batchCode = "AYB-TEST-00001", status = "CREATED",
                totalExpected = 10, totalScanned = 3),
        )
        override suspend fun batchDetail(batchId: String): BatchDetailPayload = BatchDetailPayload()
        override suspend fun batchReceiveQueue(): List<BatchRowPayload> = listOf(
            BatchRowPayload(id = "b2", batchCode = "AYB-TEST-00002", status = "SENT_TO_RECEIVING",
                totalExpected = 10, totalScanned = 0),
        )
        override suspend fun batchStartReceiving(batchId: String): BatchStartedPayload = BatchStartedPayload()
        override suspend fun batchReceiveUnit(batchId: String, unitCode: String): BatchReceiveUnitPayload =
            BatchReceiveUnitPayload()
        override suspend fun batchCompleteReceiving(batchId: String, input: BatchCompleteReceivingIn):
            BatchStartedPayload = BatchStartedPayload()
    }

    @Test
    fun batch_build_screen_composes_and_survives_interaction() {
        compose.setContent {
            AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                BatchScreen(BatchViewModel(gateway), "W-001 · UI TEST FIXTURE", "BATCH-01", "ONLINE",
                    onBack = {}, industrial = false)
            }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("BATCH_CREATE").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("BATCH_CREATE").assertIsDisplayed()
        // Second frame: interact and come back alive (the owner's crash was instant).
        compose.onNodeWithTag("BATCH_CREATE").performClick()
        compose.waitForIdle()
    }

    @Test
    fun batch_receive_screen_composes_and_shows_the_sent_queue() {
        compose.setContent {
            AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                BatchReceiveScreen(BatchReceiveViewModel(gateway), "W-001 · UI TEST FIXTURE", "BATCH-01", "ONLINE",
                    onBack = {}, industrial = false)
            }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodesWithTag("BATCH_IN_OPEN_AYB-TEST-00002").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("BATCH_IN_OPEN_AYB-TEST-00002").assertIsDisplayed()
        compose.onNodeWithTag("BATCH_IN_OPEN_AYB-TEST-00002").performClick()
        compose.waitForIdle()
    }
}
