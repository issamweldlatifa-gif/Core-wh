package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.WorkerQueueItem
import com.ayrovi.worker.scanner.WorkerDevice

/** Only rendering differs by device. Availability, permissions and counts come from shared state. */
@Composable
internal fun WorkerWorkQueue(
    state: WorkerAppState, device: WorkerDevice, connection: String, worker: String, station: String?,
    refresh: () -> Unit, logout: () -> Unit, settings: () -> Unit,
    completeInstruction: (String) -> Unit, receiving: () -> Unit, report: () -> Unit,
    showReport: Boolean, otherTask: (String) -> Unit,
) {
    val industrial = device == WorkerDevice.CT40
    Column(Modifier.fillMaxSize().background(TerminalTokens.background).safeDrawingPadding().testTag(if (industrial) "CT40_WORK_QUEUE" else "PHONE_WORK_QUEUE")) {
        TerminalHeader("WORK QUEUE", worker, station, connection, industrial = industrial, onSettings = settings)
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(TerminalTokens.sm),
            verticalArrangement = Arrangement.spacedBy(if (industrial) TerminalTokens.sm else TerminalTokens.md)) {
            if (!industrial) Text("WORK QUEUE", style = MaterialTheme.typography.titleLarge)
            if (state.busy && state.me == null) LoadingState("Opening your work queue…")
            state.message?.let { OperationalMessageView(it) }
            if (!state.verified && !state.busy) WarningState("CONNECTION UNAVAILABLE", "Refresh the connection before starting work.")
            if (state.me != null && state.queueItems.isEmpty() && !state.busy) EmptyState("NO WORK AVAILABLE", "Ask your supervisor to check your assignment.")
            QueueTiles(state.queueItems, state.verified && !state.busy, receiving, report, showReport, otherTask)
            state.context?.activeSession?.let { task ->
                if (state.queueItems.any { it.key == "receiving" && it.available }) {
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

@Composable
private fun QueueTiles(
    items: List<WorkerQueueItem>, enabled: Boolean,
    receiving: () -> Unit, report: () -> Unit, showReport: Boolean, otherTask: (String) -> Unit,
) {
    // The queue is a row of INDEPENDENT entry points: Receiving, then the
    // standalone Rapport Vérification tile, then the remaining lanes. Every
    // tile has its own route/handler — nothing is nested inside another card
    // and no two lanes share an action.
    val tiles = buildList {
        items.forEach { item ->
            add(item)
            // The report tile is synthetic (no backend task row): it shows the
            // verification report for Receiving's completed work, so it is
            // inserted right after RECEIVING — never inside any lane card.
            if (item.key == "receiving" && showReport) add(WorkerQueueItem("report", "RAPPORT VÉRIFICATION", true, null))
        }
    }
    tiles.chunked(3).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            row.forEach { item ->
                val action = when (item.key) {
                    "receiving" -> receiving
                    "report" -> report
                    else -> ({ otherTask(item.label) })
                }
                WorkflowTile(item.label, when (item.key) {
                    "receiving" -> TerminalIcon.RECEIVING
                    "report" -> TerminalIcon.REPORT
                    "sorting" -> TerminalIcon.SORTING
                    else -> TerminalIcon.PUTAWAY
                }, item.badgeCount,
                    // Receiving keeps its real readiness; every other tile is a
                    // pressable entry point that answers with its own handler
                    // (the report opens; other lanes explain they are not piloted).
                    available = item.key != "receiving" || item.available,
                    enabled, onClick = action,
                    modifier = Modifier.weight(1f).testTag("QUEUE_TILE_" + item.key.uppercase()))
            }
            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
}
