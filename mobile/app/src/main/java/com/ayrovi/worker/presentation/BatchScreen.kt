package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.batch.BatchBarcodeRenderer
import com.ayrovi.worker.batch.BatchLabelPrint
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/**
 * BATCH (native, Phase 2) — the worker builds the batch:
 *
 *   PICK/CREATE  customer name typed IN the app (needsReview is server-side)
 *   BUILD        ONE scan = ONE unit; AYP identity per piece from the server;
 *                same SKU on ten pieces = ten units (never a duplicate);
 *                MANUAL for an unreadable product (NO invented original)
 *   LABELS       per-unit AYP QR label through Android Print Framework
 *   SUBMIT       replay-safe; then the local build is wiped from the device
 *
 * House rules kept: ONE scanner surface (rememberScannerCapture), verdict
 * overlays until BACK, every BACK -> HOME, unified theme, no delete.
 */
@Composable
fun BatchScreen(
    model: BatchViewModel,
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
    var customer by remember { mutableStateOf("") }
    var externalRef by remember { mutableStateOf("") }
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
        "batch:${state.batch?.id}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    val context = LocalContext.current
    val customerName = state.batch?.customer?.name

    // v1.8-batch.7 (74) owner contract: the label carries ONLY the unit's
    // own unique barcode identity (AYP) — no customer/context lines.
    fun unitLabels(): List<BatchBarcodeRenderer.Label> = state.units.map { row ->
        BatchBarcodeRenderer.unitLabel(row.ayp)
    }

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader(
                    "BATCH", worker, station, connection,
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
                            SecondaryAction("MANUAL", { model.workflow.addManual() }, model.captureAllowed, Modifier.weight(1f))
                            SecondaryAction("SUBMIT", { model.workflow.submit() },
                                !state.busy && !state.submittedDone && state.units.isNotEmpty(), Modifier.weight(1f))
                        }
                        if (onToggleGlare != null) GlareFooterAction(glareOn, onToggleGlare)
                    }
                }
            },
            scrollKey = "batch:${state.batch?.id}",
        ) {
            val currentBatch = state.batch
            if (currentBatch == null) {
                // ---- PICK / CREATE -------------------------------------
                Column(
                    Modifier.fillMaxWidth().padding(TerminalTokens.sm),
                    verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                ) {
                    if (state.submittedDone) {
                        TerminalNotice("BATCH SUBMITTED", "Waiting for admin acceptance.", TerminalTone.SUCCESS)
                    }
                    TerminalPanel("NEW BATCH") {
                        TaskInstruction("NEW BATCH", "Type the customer name — one batch per customer visit.")
                        TerminalTextInput("CUSTOMER NAME", customer, { customer = it }, enabled = !state.busy)
                        TerminalTextInput("REFERENCE (OPTIONAL)", externalRef, { externalRef = it }, enabled = !state.busy)
                        PrimaryAction(
                            "OPEN BATCH",
                            { model.workflow.create(customer, externalRef); customer = ""; externalRef = "" },
                            !state.busy && customer.isNotBlank(),
                            Modifier.fillMaxWidth().testTag("BATCH_CREATE"),
                        )
                    }
                    if (!state.loaded && state.busy) LoadingState("Opening batches…")
                    if (state.open.isNotEmpty()) {
                        SectionDivider("RESUME — OPEN BATCHES")
                        state.open.forEach { open ->
                            SecondaryAction(
                                "${open.batchCode} · ${open.customer?.name ?: "—"} (${open.totalExpected})",
                                { model.workflow.continueBatch(open.id) },
                                !state.busy,
                                Modifier.fillMaxWidth().testTag("BATCH_RESUME_" + open.batchCode),
                            )
                        }
                    } else if (state.loaded && state.open.isEmpty() && !state.busy) {
                        EmptyState("NO OPEN BATCHES", "Open a new batch above to start scanning.")
                    }
                }
            } else {
                // ---- BUILD ----------------------------------------------
                Column(
                    Modifier.fillMaxWidth().padding(TerminalTokens.sm),
                    verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                ) {
                    TerminalPanel(currentBatch.batchCode) {
                        val live = state.units.size
                        Text(
                            "UNITS $live · CUSTOMER ${customerName ?: "—"}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = TerminalTokens.muted,
                        )
                        TaskInstruction(
                            currentBatch.batchCode,
                            if (model.captureAllowed) "Scan ONE product per beep. Same product on several pieces = scan each piece."
                            else "Scanning is paused.",
                        )
                        state.message?.takeIf { it.tone == MessageTone.INFO || it.tone == MessageTone.WARNING }
                            ?.let { OperationalMessageView(it) }
                        if (state.lastAdded != null) {
                            SecondaryAction(
                                "PRINT LAST LABEL (${state.lastAdded})",
                                { BatchLabelPrint.printUnitLabels(context, unitLabels().takeLast(1), "ayrovi-unit-${state.lastAdded}") },
                                true,
                                Modifier.fillMaxWidth().testTag("BATCH_PRINT_LAST"),
                            )
                        }
                    }
                    if (state.units.isNotEmpty()) {
                        SectionDivider("LABELS (${state.units.size})")
                        SecondaryAction(
                            "PRINT ALL LABELS",
                            { BatchLabelPrint.printUnitLabels(context, unitLabels(), "ayrovi-units-${currentBatch.batchCode}") },
                            true,
                            Modifier.fillMaxWidth().testTag("BATCH_PRINT_ALL"),
                        )
                        state.units.asReversed().forEach { row ->
                            Row(
                                Modifier.fillMaxWidth().background(TerminalTokens.surface).padding(TerminalTokens.sm),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(row.ayp, style = MaterialTheme.typography.bodyLarge)
                                    row.originalDisplay?.let {
                                        Text(it, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                                    }
                                    if (row.identifierType == "MANUAL") {
                                        Text("MANUAL — no original", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                                    }
                                }
                            }
                        }
                    } else {
                        EmptyState("NO UNITS YET", "Scan the first product to open the label list.")
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
        } else if (state.batch != null && !scanTools && !resultShown) {
            ScanToolsEdgeButton { scanTools = true }
        }
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })
        if (resultShown) {
            ScanVerdict(capture = capture,
                ok = result.tone == MessageTone.SUCCESS,
                title = result.title,
                detail = result.detail,
                lines = listOfNotNull(state.lastAdded?.let { "Unit $it" }),
                onBack = model.workflow::dismissResult,
            )
        }
    }
}
