package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/**
 * BATCH IN (native, Phase 2 receiving slice) — the station receives a batch
 * the admin SENT:
 *
 *   QUEUE   sent batches (new + resumable IN-PROGRESS), newest first
 *   RECEIVE scan AYP labels — ONE scan = ONE unit; the SAME label twice is a
 *           server no-op (ALREADY RECEIVED), progress is SERVER truth
 *   COMPLETE enabled only at 10/10 (server re-enforces); green summary
 *
 * Every BACK -> HOME; verdict overlays until BACK; ONE scanner surface;
 * unified Terminal* vocabulary. STATION NOTE: DISPATCH is outbound-only, so
 * inbound batch receiving rides this worker task — no new station entity.
 */
@Composable
fun BatchReceiveScreen(
    model: BatchReceiveViewModel,
    worker: String,
    station: String?,
    connection: String,
    onBack: () -> Unit,
    onAuthExpired: () -> Unit = {},
    industrial: Boolean,
    onToggleTheme: (() -> Unit)? = null,
    forceHardwareScanner: Boolean? = null,
    gloveOn: Boolean = false,
    onToggleGlove: (() -> Unit)? = null,
    glareOn: Boolean = false,
    onToggleGlare: (() -> Unit)? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    var scanTools by remember { mutableStateOf(false) }

    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) model.setForeground(true)
            if (event == androidx.lifecycle.Lifecycle.Event.ON_PAUSE) model.setForeground(false)
        }
        owner.lifecycle.addObserver(observer)
        model.setForeground(true)
        onDispose { owner.lifecycle.removeObserver(observer); model.setForeground(false) }
    }
    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }

    val capture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "batch-in:${state.batch?.id}:${state.scanEpoch}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader(
                    "BATCH IN", worker, station, connection,
                    onBack = onBack, industrial = industrial,
                    showSettingsIcon = false,
                )
            },
            footer = {
                TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                        SecondaryAction("BACK", {
                            if (state.batch != null) model.workflow.leaveActive() else onBack()
                        }, !state.busy, Modifier.weight(1f))
                        if (state.batch != null) {
                            SecondaryAction(
                                "COMPLETE (${state.totalScanned}/${state.totalExpected})",
                                { model.workflow.complete() },
                                !state.busy && state.completeReady,
                                Modifier.weight(1f),
                            )
                        }
                        if (onToggleGlare != null) GlareFooterAction(glareOn, onToggleGlare)
                    }
                }
            },
            scrollKey = "batch-in:${state.batch?.id}:${state.scanEpoch}",
        ) {
            val currentBatch = state.batch
            when {
                state.completed != null -> {
                    // ---- SUMMARY ---------------------------------------
                    Column(
                        Modifier.fillMaxWidth().padding(TerminalTokens.sm),
                        verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                    ) {
                        TerminalNotice(
                            "RECEIVING COMPLETED",
                            "${state.completed?.batchCode} — ${state.completed?.totalExpected} unit(s) received.",
                            TerminalTone.SUCCESS,
                        )
                        PrimaryAction(
                            "BACK TO QUEUE",
                            { model.workflow.dismissSummary() },
                            true,
                            Modifier.fillMaxWidth().testTag("BATCH_IN_DONE"),
                        )
                    }
                }
                currentBatch == null -> {
                    // ---- QUEUE -----------------------------------------
                    Column(
                        Modifier.fillMaxWidth().padding(TerminalTokens.sm),
                        verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                    ) {
                        state.message?.takeIf { it.tone == MessageTone.WARNING }
                            ?.let { OperationalMessageView(it) }
                        if (!state.loaded && state.busy) LoadingState("Opening the receiving queue…")
                        if (state.queue.isEmpty() && state.loaded && !state.busy) {
                            EmptyState("NO BATCHES WAITING", "Batches the admin sends appear here.")
                        }
                        state.queue.forEach { queued ->
                            SecondaryAction(
                                "${queued.batchCode} · ${queued.customer?.name ?: "—"} (${queued.totalExpected})",
                                { model.workflow.start(queued.id) },
                                !state.busy,
                                Modifier.fillMaxWidth().testTag("BATCH_IN_OPEN_" + queued.batchCode),
                            )
                        }
                    }
                }
                else -> {
                    // ---- RECEIVE ---------------------------------------
                    Column(
                        Modifier.fillMaxWidth().padding(TerminalTokens.sm),
                        verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                    ) {
                        TerminalPanel(currentBatch.batchCode) {
                            Text(
                                "UNITS ${state.totalScanned}/${state.totalExpected} · CUSTOMER ${currentBatch.customer?.name ?: "—"}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = TerminalTokens.muted,
                            )
                            TaskInstruction(
                                currentBatch.batchCode,
                                if (model.captureAllowed) "Scan ONE unit per beep. A repeated label is a safe no-op."
                                else "Scanning is paused.",
                            )
                            state.message?.takeIf { it.tone == MessageTone.INFO || it.tone == MessageTone.WARNING }
                                ?.let { OperationalMessageView(it) }
                        }
                        if (state.lastUnit != null) {
                            Text(
                                "LAST: ${state.lastUnit}",
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.testTag("BATCH_IN_LAST"),
                            )
                        }
                    }
                }
            }
        }

        // ONE scanner surface: camera tools + verdict overlay, house pattern.
        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        val result = state.message
        val resultShown = result != null && (result.tone == MessageTone.SUCCESS || result.tone == MessageTone.ERROR)
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (state.batch != null && state.completed == null && !scanTools && !resultShown) {
            ScanToolsEdgeButton { scanTools = true }
        }
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })
        if (resultShown) {
            ScanVerdict(capture = capture,
                ok = result.tone == MessageTone.SUCCESS,
                title = result.title,
                detail = result.detail,
                lines = listOfNotNull(state.lastUnit?.let { "Unit $it" }),
                onBack = model.workflow::dismissResult,
            )
        }
    }
}
