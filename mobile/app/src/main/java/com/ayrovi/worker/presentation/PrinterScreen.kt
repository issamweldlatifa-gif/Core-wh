package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import com.ayrovi.worker.design.PrimaryAction
import com.ayrovi.worker.design.SecondaryAction
import com.ayrovi.worker.design.TaskInstruction
import com.ayrovi.worker.design.TerminalFooter
import com.ayrovi.worker.design.TerminalHeader
import com.ayrovi.worker.design.TerminalIcon
import com.ayrovi.worker.design.TerminalNotice
import com.ayrovi.worker.design.TerminalPanel
import com.ayrovi.worker.design.TerminalShell
import com.ayrovi.worker.design.TerminalTone
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.printer.PrinterConnectionState
import com.ayrovi.worker.printer.PrinterInfo
import com.ayrovi.worker.printer.PrinterRuntime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * PRINTER (owner order 2026-09-16).
 *
 * The CT40 prints on its own now. Until this screen existed the printer could
 * only be reached through the loopback print bridge — i.e. only from the web
 * admin running in a browser ON this device, with the bridge enabled and the
 * browser's local-network permission granted. Whoever asked the obvious question
 * («why do I need the web admin and the bridge just to connect my printer?») was
 * right: the app already owned the whole printer stack, only the screen was
 * missing.
 *
 * What it does, in the operator's order: SEARCH (paired printers first, then a
 * bounded radio scan) → CONNECT → TEST PRINT. One tap prints one label. The
 * bridge stays where it belongs — a switch at the bottom, only needed when the
 * web admin wants to print from this device.
 *
 * It talks to the SAME PrinterManager as the bridge service and the print agent
 * (PrinterRuntime): one socket, one duplicate-protection window, one status.
 * Nothing is printed from here except what the operator asks for.
 */
@Composable
fun PrinterScreen(
    runtime: PrinterRuntime.Stack,
    worker: String,
    station: String?,
    connection: String,
    industrial: Boolean,
    agentPrinted: Int,
    onBack: () -> Unit,
    bridgeRunning: Boolean = false,
    bridgeError: String? = null,
    onToggleBridge: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val manager = runtime.manager

    // The manager is the single source of truth; this screen mirrors it and
    // re-reads it whenever the manager announces a change.
    var tick by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf<String?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var found by remember { mutableStateOf<List<PrinterInfo>>(emptyList()) }
    var note by remember { mutableStateOf<Pair<String, TerminalTone>?>(null) }

    DisposableEffect(manager) {
        val listener: (PrinterConnectionState, String?) -> Unit = { _, _ -> tick += 1 }
        manager.addListener(listener)
        onDispose { manager.removeListener(listener) }
    }

    val state = remember(tick) { manager.state }
    val connected = remember(tick) { manager.connectedPrinter }
    val saved = remember(tick) { manager.status().savedPrinter }
    val failure = remember(tick) { manager.lastError }
    val known = remember(tick) { connected ?: saved }

    /** Every printer call can block on the radio — never on the UI thread. */
    fun run(label: String, block: () -> Boolean) {
        if (busy != null) return
        busy = label
        note = null
        scope.launch {
            val ok = withContext(Dispatchers.IO) { runCatching { block() }.getOrElse { false } }
            tick += 1
            busy = null
            note = if (ok) {
                "Done." to TerminalTone.SUCCESS
            } else {
                (manager.lastError?.userMessage ?: "The printer did not answer.") to TerminalTone.ERROR
            }
        }
    }

    fun search() {
        if (busy != null || scanning) return
        busy = "search"
        note = null
        found = emptyList()
        scope.launch {
            // Paired printers first: the PM-241-BT bond survives reinstalls and
            // never needs a live scan.
            val bonded = withContext(Dispatchers.IO) {
                runCatching { manager.bondedPrinters() }.getOrDefault(emptyList())
            }
            found = bonded
            if (bonded.isEmpty()) {
                scanning = true
                val seen = mutableListOf<PrinterInfo>()
                withContext(Dispatchers.IO) {
                    runCatching {
                        runtime.finder.startScan(
                            onDevice = { p -> if (seen.none { it.address == p.address }) seen.add(p) },
                            onFinished = { },
                        )
                        // Bounded discovery (~10 s), exactly like the bridge does.
                        delay(10_000)
                        runtime.finder.stopScan()
                    }
                }
                scanning = false
                found = seen.toList()
            }
            tick += 1
            busy = null
            val error = manager.lastError
            note = when {
                found.isNotEmpty() -> "Found ${found.size} printer(s)." to TerminalTone.SUCCESS
                error != null -> error.userMessage to TerminalTone.ERROR
                else -> "No printer found. Pair the PM-241-BT once in Android Bluetooth settings, then search again." to TerminalTone.WARNING
            }
        }
    }

    TerminalShell(
        header = {
            TerminalHeader(
                operation = "PRINTER",
                worker = worker,
                station = station,
                connection = connection,
                onBack = onBack,
                industrial = industrial,
                showSettingsIcon = false,
            )
        },
        footer = {
            TerminalFooter("LABELS OVER BLUETOOTH") {
                if (connected != null) {
                    PrimaryAction("TEST PRINT", { run("test") { manager.testPrint("ct40-test-${System.currentTimeMillis()}").ok } }, busy == null, icon = TerminalIcon.PRINTER)
                } else {
                    PrimaryAction(
                        if (busy == "search") "SEARCHING…" else "SEARCH PRINTERS",
                        { search() },
                        busy == null && !scanning,
                        icon = TerminalIcon.SCANNER,
                    )
                }
            }
        },
    ) {
        TaskInstruction(
            "PRINTER",
            detail = "Connect the label printer, then print a test label. Printing works from the app — the web admin and the bridge are NOT needed.",
        )

        TerminalPanel("STATUS") {
            Text(
                when (state) {
                    PrinterConnectionState.CONNECTED -> "CONNECTED"
                    PrinterConnectionState.PRINTING -> "PRINTING…"
                    PrinterConnectionState.CONNECTING -> "CONNECTING…"
                    PrinterConnectionState.ERROR -> "PROBLEM"
                    PrinterConnectionState.DISCONNECTED -> "NOT CONNECTED"
                },
                style = MaterialTheme.typography.titleMedium,
                color = when (state) {
                    PrinterConnectionState.CONNECTED, PrinterConnectionState.PRINTING -> TerminalTokens.success
                    PrinterConnectionState.ERROR -> TerminalTokens.error
                    else -> TerminalTokens.muted
                },
            )
            known?.let {
                Text(it.name, style = MaterialTheme.typography.bodyLarge)
                Text(it.address, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
            }
            if (agentPrinted > 0) {
                Text(
                    "$agentPrinted label(s) printed here",
                    style = MaterialTheme.typography.bodySmall,
                    color = TerminalTokens.muted,
                )
            }
        }

        failure?.let { TerminalNotice("PRINTER", it.userMessage, TerminalTone.ERROR) }
        note?.let { TerminalNotice("", it.first, it.second) }

        when {
            connected != null -> {
                TerminalPanel("LINK") {
                    SecondaryAction("RECONNECT", { run("reconnect") { manager.reconnect() } }, busy == null, icon = TerminalIcon.REFRESH)
                    SecondaryAction("DISCONNECT", { run("disconnect") { manager.disconnect(); true } }, busy == null, icon = TerminalIcon.OFFLINE)
                    SecondaryAction("FORGET SAVED PRINTER", { run("forget") { runtime.store.clearSaved(); manager.disconnect(); true } }, busy == null, icon = TerminalIcon.ERROR)
                }
            }
            else -> {
                TerminalPanel("PRINTERS") {
                    if (busy == "search" || scanning) {
                        Text("Looking for printers…", style = MaterialTheme.typography.bodyMedium)
                    } else if (found.isEmpty()) {
                        Text(
                            "Press SEARCH PRINTERS. The printer must be switched on and paired in Android Bluetooth settings.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TerminalTokens.muted,
                        )
                    } else {
                        found.forEach { p ->
                            Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                                Text(p.name, style = MaterialTheme.typography.bodyLarge)
                                Text(p.address, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                                SecondaryAction(
                                    if (busy == "connect") "CONNECTING…" else "CONNECT",
                                    { run("connect") { manager.connect(p.address, p.name) } },
                                    busy == null,
                                    icon = TerminalIcon.ONLINE,
                                )
                            }
                        }
                    }
                }
            }
        }

        if (onToggleBridge != null) {
            TerminalPanel("ADMIN WEB BRIDGE") {
                Text(
                    when {
                        bridgeError != null -> "FAILED: $bridgeError"
                        bridgeRunning -> "RUNNING · 127.0.0.1:8787"
                        else -> "OFF"
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        bridgeError != null -> TerminalTokens.warning
                        bridgeRunning -> TerminalTokens.success
                        else -> TerminalTokens.muted
                    },
                )
                Text(
                    "Only for printing from the Admin web page open on THIS device. The app prints without it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = TerminalTokens.muted,
                )
                SecondaryAction(
                    if (bridgeRunning) "DISABLE BRIDGE" else "ENABLE BRIDGE",
                    onToggleBridge,
                    true,
                    icon = TerminalIcon.ONLINE,
                )
            }
        }
    }
}
