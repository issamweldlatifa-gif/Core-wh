package com.ayrovi.worker

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.ayrovi.worker.data.ConnectionState
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.data.WorkerTransport
import com.ayrovi.worker.design.AyroviTerminalTheme
import com.ayrovi.worker.design.TerminalThemeMode
import com.ayrovi.worker.presentation.ReceivingHomeScreen
import com.ayrovi.worker.presentation.ReceivingHomeViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test

/**
 * RECEIVING REDESIGN §5 — Report History lives ONLY in
 * SETTINGS → RAPPORT HISTORY. Never on the home, the scanner, a lane or a
 * result screen. Real backend shape, served by a fake transport.
 */
class ReportHistoryUiTest {

    @get:Rule
    val compose = createComposeRule()

    private class HistoryTransport(private val payload: String) : WorkerTransport {
        override val connection = MutableStateFlow(ConnectionState.ONLINE)
        override suspend fun request(method: String, path: String, body: String?, authenticated: Boolean): String =
            if (path.contains("sessions/history")) payload else "{}"
        override fun networkAvailable(available: Boolean) = Unit
    }

    private fun openReceivingWithHistory(payload: String) {
        val model = ReceivingHomeViewModel(ReceivingUiGateway(), "worker", setOf("receiving.view", "receiving.execute"))
        val repository = WorkerRepository(UiSessionStorage(), HistoryTransport(payload))
        compose.setContent {
            LaunchedEffect(Unit) { model.activate(setOf("receiving.view", "receiving.execute"), true) }
            Box(Modifier.fillMaxSize().testTag("HANDHELD")) {
                AyroviTerminalTheme(TerminalThemeMode.WHITE, onToggleTheme = {}) {
                    ReceivingHomeScreen(model, "W-001 · UI TEST FIXTURE", "REC-01", "ONLINE", {}, {},
                        repository = repository)
                }
            }
        }
        compose.waitUntil(10_000) { model.state.value.loaded && !model.state.value.busy }
    }

    private fun openSettings() {
        compose.onNodeWithContentDescription("Worker and settings").performClick()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("SETTINGS").fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun reportHistoryLivesOnlyInSettings() {
        openReceivingWithHistory(
            """[{"sessionId":"s-1","sessionCode":"RCV-000201","arrivalCode":"WAR-001","status":"COMPLETED","reportStatus":"SUBMITTED","submittedAt":"2026-09-09T09:05:00Z"},""" +
                """{"sessionId":"s-2","sessionCode":"RCV-000202","arrivalCode":"WAR-002","status":"COMPLETED","reportStatus":"SUBMITTED","submittedAt":"2026-09-08T10:00:00Z"}]""",
        )

        // Operational UI: no history anywhere.
        compose.onAllNodesWithTag("HISTORY_LIST").assertCountEquals(0)
        compose.onAllNodesWithTag("HISTORY_EMPTY").assertCountEquals(0)
        compose.onAllNodesWithText("RCV-000201").assertCountEquals(0)
        compose.onAllNodesWithText("RAPPORT HISTORY").assertCountEquals(0)

        // SETTINGS → RAPPORT HISTORY: the two past sessions, newest first.
        openSettings()
        compose.onNodeWithText("RAPPORT HISTORY").performScrollTo().assertIsDisplayed()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("HISTORY_LIST").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithTag("HISTORY_LIST").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("RCV-000201").assertIsDisplayed()
        compose.onNodeWithText("RCV-000202").assertIsDisplayed()
        compose.onNodeWithText("CLOSE").performClick()
        compose.onAllNodesWithTag("HISTORY_LIST").assertCountEquals(0)
    }

    @Test
    fun emptyHistoryShowsProfessionalEmptyState() {
        openReceivingWithHistory("[]")
        openSettings()
        compose.onNodeWithText("RAPPORT HISTORY").performScrollTo().assertIsDisplayed()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithTag("HISTORY_EMPTY").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("No submitted reports yet.").assertIsDisplayed()
        // No invented rows: the empty state is the whole list.
        compose.onAllNodesWithTag("HISTORY_LIST").assertCountEquals(0)
    }
}
