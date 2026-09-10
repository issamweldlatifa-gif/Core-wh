package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ayrovi.worker.design.*
import com.ayrovi.worker.scanner.WorkerDevice

/**
 * HOME (UX RESTRUCTURE §3/§4) — a simple, clear terminal:
 *
 *                AYROVI
 *             [ RECEIVING ]        ← the main entry to the operation
 *          [ OCR ]    [ QR CODE ]  ← independent tools (§9/§14)
 *        [ RAPPORT ] [ SETTINGS ]  ← independent tools (§4)
 *
 * Settings is NO LONGER in the header — its ONE entry point is this screen
 * (§16). The worker's other assigned stations (Temporary Storage, Sorting,
 * Packing…) keep their own tiles below (§17: no feature is removed), and the
 * instructions + REFRESH / SIGN OUT actions are unchanged. Availability,
 * permissions and counts keep coming from shared state — only rendering and
 * navigation changed.
 */

/** Only rendering differs by device. Availability, permissions and counts come from shared state. */
@Composable
internal fun WorkerHomeScreen(
    state: WorkerAppState, device: WorkerDevice, connection: String, worker: String, station: String?,
    refresh: () -> Unit, logout: () -> Unit, settings: () -> Unit,
    completeInstruction: (String) -> Unit, receiving: () -> Unit, report: () -> Unit,
    showReport: Boolean, openOcr: () -> Unit, openQr: () -> Unit,
    temporaryStorage: () -> Unit, otherTask: (String) -> Unit,
) {
    val industrial = device == WorkerDevice.CT40
    val receivingItem = state.queueItems.firstOrNull { it.key == "receiving" }
    val receivingReady = receivingItem?.available == true
    Column(Modifier.fillMaxSize().background(TerminalTokens.background).safeDrawingPadding().testTag(if (industrial) "CT40_HOME" else "PHONE_HOME")) {
        // §16: NO settings icon in the header. Settings lives on Home.
        TerminalHeader("AYROVI", worker, station, connection, industrial = industrial, showSettingsIcon = false)
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(TerminalTokens.sm),
            verticalArrangement = Arrangement.spacedBy(if (industrial) TerminalTokens.sm else TerminalTokens.md)) {
            if (!industrial) {
                Text("AYROVI", style = MaterialTheme.typography.headlineMedium, letterSpacing = 6.sp,
                    modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
            }
            if (state.busy && state.me == null) LoadingState("Opening your work queue…")
            state.message?.let { OperationalMessageView(it) }
            if (!state.verified && !state.busy) WarningState("CONNECTION UNAVAILABLE", "Refresh the connection before starting work.")
            if (state.me != null && state.queueItems.isEmpty() && !state.busy) EmptyState("NO WORK AVAILABLE", "Ask your supervisor to check your assignment.")

            // ---- The main entry: RECEIVING (§3) ----
            Box(Modifier.fillMaxWidth().testTag("HOME_RECEIVING")) {
                LaneTile("RECEIVING", TerminalIcon.RECEIVING, receivingReady, receiving,
                    Modifier.fillMaxWidth(), dot = (state.unreadBadge ?: 0) > 0,
                    reason = if (receivingReady) null else tileReason(state, connection))
                receivingItem?.count?.takeIf { it > 0 }?.let { count ->
                    Text("$count WAITING", style = MaterialTheme.typography.labelMedium,
                        color = TerminalTokens.muted, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = TerminalTokens.xs))
                }
            }

            // ---- Independent tools (§9/§14): OCR and QR CODE open their
            //      scanner DIRECTLY — no lane picker, no intermediate screen.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Box(Modifier.weight(1f).testTag("HOME_OCR")) {
                    LaneTile("OCR", TerminalIcon.GLARE, state.verified && receivingReady, openOcr,
                        Modifier.fillMaxWidth(), reason = if (receivingReady) null else "NO RECEIVING WORK")
                }
                Box(Modifier.weight(1f).testTag("HOME_QR")) {
                    LaneTile("QR CODE", TerminalIcon.SCANNER, state.verified && receivingReady, openQr,
                        Modifier.fillMaxWidth(), reason = if (receivingReady) null else "NO RECEIVING WORK")
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                if (showReport) {
                    Box(Modifier.weight(1f).testTag("HOME_RAPPORT")) {
                        LaneTile("RAPPORT", TerminalIcon.REPORT, state.verified, report, Modifier.fillMaxWidth())
                    }
                    Box(Modifier.weight(1f).testTag("HOME_SETTINGS")) {
                        LaneTile("SETTINGS", TerminalIcon.SETTINGS, true, settings, Modifier.fillMaxWidth())
                    }
                } else {
                    // Rapport is tied to Receiving (existing rule: it shows the
                    // verification report of Receiving's completed work), so
                    // without Receiving the row keeps its two-slot shape.
                    Box(Modifier.weight(1f).testTag("HOME_RAPPORT")) {
                        LaneTile("RAPPORT", TerminalIcon.REPORT, false, {}, Modifier.fillMaxWidth(), reason = "NEEDS RECEIVING")
                    }
                    Box(Modifier.weight(1f).testTag("HOME_SETTINGS")) {
                        LaneTile("SETTINGS", TerminalIcon.SETTINGS, true, settings, Modifier.fillMaxWidth())
                    }
                }
            }

            // ---- The worker's other assigned stations (§17: preserved) ----
            val stations = state.queueItems.filter { it.key != "receiving" }
            if (stations.isNotEmpty()) {
                SectionDivider("STATIONS")
                stations.chunked(3).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                        row.forEach { item ->
                            WorkflowTile(item.label, when (item.key) {
                                "sorting" -> TerminalIcon.SORTING
                                "temporary-storage" -> TerminalIcon.STORAGE
                                "shipping" -> TerminalIcon.CARTON
                                "archive-trace" -> TerminalIcon.STATION
                                else -> TerminalIcon.PUTAWAY
                            }, item.badgeCount,
                                // Every station keeps its own handler — nothing
                                // is nested inside another card (§15).
                                available = true, state.verified && !state.busy,
                                onClick = {
                                    when (item.key) {
                                        "temporary-storage" -> temporaryStorage()
                                        else -> otherTask(item.key)
                                    }
                                },
                                modifier = Modifier.weight(1f).testTag("HOME_STATION_" + item.key.uppercase()))
                        }
                        repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }

            state.context?.activeSession?.let { task ->
                if (receivingReady) {
                    SecondaryAction("CONTINUE ${task.code}", receiving, state.verified && !state.busy)
                }
            }
            if (!industrial) state.assignments?.open?.forEach { instruction ->
                TerminalPanel("YOUR INSTRUCTION") {
                    Text(instruction.title, style = MaterialTheme.typography.titleMedium)
                    instruction.relatedCode?.let { BarcodeDisplay(it) }
                    instruction.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    if (instruction.isInstruction) SecondaryAction("MARK INSTRUCTION DONE", { completeInstruction(instruction.id) }, state.verified && !state.busy)
                }
            }
            if (industrial && state.assignments?.open?.isNotEmpty() == true) Text("${state.assignments.open.size} INSTRUCTIONS · OPEN SETTINGS TO REVIEW",
                style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        }
        TerminalFooter("") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                SecondaryAction("REFRESH QUEUE", refresh, !state.busy, Modifier.weight(1f))
                SecondaryAction("SIGN OUT", logout, !state.busy, Modifier.weight(1f))
            }
        }
    }
}

/** Flat section divider — uppercase label + rule, no nested boxes (§15). */
@Composable
private fun SectionDivider(title: String) {
    Row(Modifier.fillMaxWidth().padding(top = TerminalTokens.xs), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = TerminalTokens.muted, letterSpacing = 2.sp)
        Box(Modifier.weight(1f).height(1.dp).background(TerminalTokens.border))
    }
}

/** Why the RECEIVING entry is not ready right now (null = ready, nothing shown). */
private fun tileReason(state: WorkerAppState, connection: String): String = when {
    state.busy -> "PLEASE WAIT"
    connection == "OFFLINE" -> "OFFLINE"
    !state.verified -> "CHECKING…"
    else -> "NOT ASSIGNED"
}
