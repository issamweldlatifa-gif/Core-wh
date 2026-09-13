package com.ayrovi.worker.presentation

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import kotlinx.coroutines.delay

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
                            // ORDER 01 follow-up: MANUAL is now the ONE manual
                            // entry (the CT40 edge button is retired): it opens
                            // the type-in tool; a blank unit can be added there.
                            SecondaryAction("MANUAL", { capture.manual() }, model.captureAllowed, Modifier.weight(1f))
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
                        val target = currentBatch.totalExpected
                        // ORDER 01 follow-up: the running total is THE number
                        // of this station — big, glanceable, one line.
                        Row(verticalAlignment = Alignment.Bottom) {
                            Text("$live", style = MaterialTheme.typography.displayMedium, color = TerminalTokens.text)
                            if (target > 0) Text(" / $target", style = MaterialTheme.typography.titleLarge, color = TerminalTokens.muted)
                            Spacer(Modifier.weight(1f))
                            Text("CUSTOMER ${customerName ?: "—"}", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                        }
                        Text("UNITS ADDED", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
                        TaskInstruction(
                            currentBatch.batchCode,
                            if (model.captureAllowed) "Scan ONE product per beep. Same product on several pieces = scan each piece."
                            else "Scanning is paused.",
                        )
                        if (model.captureAllowed) {
                            Row(
                                Modifier.fillMaxWidth().background(TerminalTokens.surface)
                                    .testTag("SCANNER_READY_STRIP").padding(TerminalTokens.sm),
                                horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                WorkerIcon(TerminalIcon.SCANNER, null, Modifier.size(TerminalTokens.iconSmall), TerminalTokens.success)
                                Text("SCANNER READY — PULL THE TRIGGER TO ADD A UNIT",
                                    style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
                            }
                        }
                        state.message?.takeIf { it.tone == MessageTone.INFO || it.tone == MessageTone.WARNING }
                            ?.let { OperationalMessageView(it) }
                        if (state.lastAdded != null) {
                            // ORDER 01 follow-up: visible "SENT" state blocks the
                            // double tap that printed a duplicate label stack.
                            var lastSent by remember { mutableStateOf(false) }
                            LaunchedEffect(lastSent) { if (lastSent) { delay(2500); lastSent = false } }
                            SecondaryAction(
                                if (lastSent) "LABEL SENT ✓" else "PRINT LAST LABEL (${state.lastAdded})",
                                { BatchLabelPrint.printUnitLabels(context, unitLabels().takeLast(1), "ayrovi-unit-${state.lastAdded}"); lastSent = true },
                                !lastSent,
                                Modifier.fillMaxWidth().testTag("BATCH_PRINT_LAST"),
                            )
                        }
                    }
                    if (state.units.isNotEmpty()) {
                        SectionDivider("LABELS (${state.units.size})")
                        var allSent by remember { mutableStateOf(false) }
                        LaunchedEffect(allSent) { if (allSent) { delay(2500); allSent = false } }
                        SecondaryAction(
                            if (allSent) "${state.units.size} LABELS SENT ✓" else "PRINT ALL LABELS (${state.units.size})",
                            { BatchLabelPrint.printUnitLabels(context, unitLabels(), "ayrovi-units-${currentBatch.batchCode}"); allSent = true },
                            !allSent,
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
        // ORDER 01 follow-up: the type-in manual entry renders at screen level
        // so it WORKS on the CT40 (the old path lived inside the camera
        // overlay, which never opens on an imager device — the drawer MANUEL
        // button did nothing there). SUBMIT CODE runs the SAME scan pipeline.
        if (capture.manualOpen && !cameraActive) {
            Box(Modifier.fillMaxSize().testTag("MANUAL_ENTRY_OVERLAY")) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)).clickable(onClick = capture.cancel))
                Surface(
                    Modifier.align(Alignment.Center).fillMaxWidth().padding(TerminalTokens.sm),
                    color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
                    border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
                ) {
                    Column(Modifier.padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                        ManualScan(capture, model.captureAllowed)
                        SecondaryAction(
                            "ADD UNIT WITHOUT ORIGINAL",
                            { model.workflow.addManual(); capture.cancel() },
                            model.captureAllowed && !state.busy,
                            Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
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
