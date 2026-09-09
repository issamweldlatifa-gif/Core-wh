package com.ayrovi.worker.presentation

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.TsStorageState
import com.ayrovi.worker.scanner.ScannerCapture
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture
import kotlinx.coroutines.delay

/**
 * TEMPORARY STORAGE station — native worker app (CT40 / phone), MASTER ORDER.
 *
 * Scan-first: scan PRODUCT -> the backend resolves customer/section and the
 * TARGET CONTAINER lights up in AMBER on the board (pulsing border + badge)
 * so the worker knows exactly which container to scan next; scan CONTAINER ->
 * server VALID (green flash) / WRONG CONTAINER (red flash, nothing stored) /
 * FULL auto-advance / REVIEW / CARTON_NOT_ALLOWED. No manual section or
 * container entry — the device renders server truth only.
 */
@Composable
fun TempStorageScreen(
    model: TempStorageViewModel,
    worker: String,
    station: String?,
    connection: String,
    onBack: () -> Unit,
    onAuthExpired: () -> Unit = {},
    industrial: Boolean,
    repository: WorkerRepository,
    appVersion: String,
    deviceCode: String,
    device: WorkerDevice,
    onToggleTheme: () -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var settings by remember { mutableStateOf(false) }
    var reportOpen by remember { mutableStateOf(false) }
    var observation by remember { mutableStateOf("") }

    DisposableEffect(owner, model) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> model.setForeground(true)
                Lifecycle.Event.ON_PAUSE -> model.setForeground(false)
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        model.setForeground(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED))
        onDispose {
            owner.lifecycle.removeObserver(observer)
            model.setForeground(false)
        }
    }

    val capture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "ts:${state.letter}:${state.pending?.targetCode}:${state.scanEpoch}", model::onScan,
    )

    // Flash feedback auto-clears after ~1.2s.
    LaunchedEffect(state.flashOk, state.flashBad) {
        if (state.flashOk != null || state.flashBad != null) { delay(1200); model.workflow.clearFlash() }
    }

    TerminalShell(
        header = {
            TerminalHeader("TEMP STORAGE", worker, station, connection,
                onBack = if (state.letter != null) ({ model.workflow.goHome() }) else onBack,
                industrial = industrial, onSettings = { settings = true })
        },
        footer = {
            TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    SecondaryAction(if (state.letter != null) "ALL SECTIONS" else "BACK", {
                        if (state.letter != null) model.workflow.goHome() else onBack()
                    }, !state.busy, Modifier.weight(1f))
                    SecondaryAction(if (state.reportSent) "REPORT SUBMITTED" else "RAPPORT DE FIN", { reportOpen = true },
                        !state.busy && !state.reportSent, Modifier.weight(1f))
                    SecondaryAction("REFRESH", model.workflow::refresh, !state.busy, Modifier.weight(1f))
                }
            }
        },
        scrollKey = "${state.letter}:${state.pending?.targetCode}:${state.scanEpoch}",
    ) {
        when {
            !state.loaded -> LoadingState("OPENING TEMPORARY STORAGE…")
            state.letter == null -> TsHomeBody(state, model, capture, industrial)
            else -> TsBoardBody(state, model, capture, industrial)
        }
        state.message?.let { OperationalMessageView(it) }
        if (state.letter == null && state.home?.header?.activeProducts == 0) {
            EmptyState("NO CONFIRMED PRODUCTS", "Nothing is waiting for Temporary Storage yet. Confirm products at Receiving first.")
        }
        if (reportOpen) ReportPanel(state, observation, { observation = it },
            submit = { model.workflow.submitReport(observation.trim().ifEmpty { null }); reportOpen = false })
    }

    if (settings) {
        WorkerSettingsDialog(
            repository = repository,
            worker = worker, station = station, connection = connection,
            appVersion = appVersion, deviceCode = deviceCode, device = device,
            onSwitchMode = { settings = false; onBack() },
            onClose = { settings = false },
            onChangeDisplay = onToggleTheme,
        )
    }
}

@Composable
private fun TsHomeBody(
    state: TsStorageState, model: TempStorageViewModel,
    capture: ScannerCapture, industrial: Boolean,
) {
    val home = state.home
    if (home == null) return
    // ---- live header counters (real /home data) ----
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        MetricBox("ACTIVE", home.header?.activeProducts ?: 0, TerminalTokens.primary, Modifier.weight(1f))
        MetricBox("STORED", home.header?.completed ?: 0, TerminalTokens.success, Modifier.weight(1f))
        MetricBox("REMAINING", home.header?.remaining ?: 0, TerminalTokens.text, Modifier.weight(1f))
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        MetricBox("IN REVIEW", home.header?.review ?: 0,
            if ((home.header?.review ?: 0) > 0) TerminalTokens.error else TerminalTokens.muted, Modifier.weight(1f))
        MetricBox("CONTAINERS", home.header?.containers ?: 0, TerminalTokens.instruction, Modifier.weight(1f))
        MetricBox("", 0, TerminalTokens.muted, Modifier.weight(1f), blank = true)
    }
    TaskInstruction("SCAN PRODUCT", "The system finds the customer → section → target container.")

    if (home.sections.isNotEmpty()) {
        Text("SECTIONS (${home.sections.size})", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.muted)
        Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            home.sections.forEach { section ->
                SectionCard(
                    letter = section.letter ?: "—",
                    active = section.letter != null && section.letter == home.currentSection,
                    summary = section.customers.joinToString(" · ") {
                        listOfNotNull(it.customer, it.received?.let { r -> "$r units" }).joinToString(" ")
                    },
                    onClick = { section.letter?.let { model.workflow.openSection(it) } },
                    modifier = Modifier.testTag("TS_SECTION_${(section.letter ?: "?").uppercase()}"),
                )
            }
        }
    }
    TsScannerControls(capture, state, model)
}

@Composable
private fun MetricBox(label: String, value: Int, color: Color, modifier: Modifier = Modifier, blank: Boolean = false) {
    Surface(modifier = modifier, color = TerminalTokens.surface, shape = MaterialTheme.shapes.small,
        border = BorderStroke(TerminalTokens.stroke, if (blank) Color.Transparent else TerminalTokens.border)) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(if (blank) "" else value.toString(),
                style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace), color = color)
            if (!blank) Text(label, style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
        }
    }
}

@Composable
private fun SectionCard(letter: String, active: Boolean, summary: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(modifier = modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.small,
        border = BorderStroke(TerminalTokens.stroke,
            if (active) TerminalTokens.warning else TerminalTokens.border)) {
        Row(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                Surface(color = if (active) TerminalTokens.warning else TerminalTokens.primary,
                    shape = MaterialTheme.shapes.small) {
                    Text(letter, Modifier.padding(10.dp),
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Black),
                        color = TerminalTokens.onPrimary)
                }
            }
            Column(Modifier.weight(1f)) {
                Text("SECTION $letter", style = MaterialTheme.typography.titleMedium)
                if (summary.isNotBlank()) Text(summary, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted, maxLines = 2)
            }
            if (active) Text("ACTIVE TARGET", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.warning)
            OutlinedButton(onClick, Modifier.testTag("OPEN_SECTION")) { Text("OPEN", style = MaterialTheme.typography.labelMedium) }
        }
    }
}

@Composable
private fun TsBoardBody(
    state: TsStorageState, model: TempStorageViewModel,
    capture: ScannerCapture, industrial: Boolean,
) {
    val board = state.board ?: return
    // ---- pending target banner: THE container to scan, amber pulse ----
    val pending = state.pending
    if (pending != null) {
        val pulse by rememberInfiniteTransition(label = "ts-target-pulse")
            .animateFloat(0.55f, 1f,
                infiniteRepeatable(tween(650), RepeatMode.Reverse), label = "ts-pulse")
        Surface(Modifier.fillMaxWidth().testTag("TS_TARGET_${pending.targetCode}"),
            color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
            border = BorderStroke(3.dp, TerminalTokens.warning.copy(alpha = pulse))) {
            Column(Modifier.fillMaxWidth().padding(TerminalTokens.md),
                verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                    Text("▶ PLACE HERE", style = MaterialTheme.typography.labelMedium,
                        color = TerminalTokens.warning, modifier = Modifier.weight(1f))
                    if (pending.mustCreate) Text("NEW", style = MaterialTheme.typography.labelSmall,
                        color = TerminalTokens.onPrimary, modifier = Modifier
                            .testTag("NEW_CONTAINER"))
                }
                BarcodeDisplay(pending.targetCode)
                Text("Customer ${pending.customer} · Section ${pending.section} · ${pending.remaining} left",
                    style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                Text("SCAN CONTAINER ${pending.targetCode}", style = MaterialTheme.typography.titleMedium,
                    color = TerminalTokens.warning)
            }
        }
    } else if (state.home?.currentSection != null && state.letter == state.home.currentSection) {
        Text("This section is the ACTIVE TARGET — scan a product to place it.",
            style = MaterialTheme.typography.bodySmall, color = TerminalTokens.warning)
    }

    // ---- unknown scan → Review lane prompt ----
    state.unknownCode?.let { code ->
        Surface(Modifier.fillMaxWidth().testTag("TS_UNKNOWN"), color = TerminalTokens.surface,
            shape = MaterialTheme.shapes.small, border = BorderStroke(TerminalTokens.stroke, TerminalTokens.error)) {
            Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Text("NO CONFIRMED PRODUCT", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.error)
                BarcodeDisplay(code)
                Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    PrimaryAction("SEND TO REVIEW", model.workflow::sendToReview,
                        model.captureAllowed, Modifier.weight(1f))
                    SecondaryAction("RESCAN", model.workflow::dismissUnknown,
                        true, Modifier.weight(1f))
                }
            }
        }
    }

    // ---- customer groups + container grid ----
    if (board.customers.isEmpty()) {
        EmptyState("NO ACTIVE CUSTOMER BATCH", "Nothing is waiting in section ${state.letter}.")
    }
    board.customers.forEach { group ->
        val stored = group.stored ?: 0
        val received = group.received ?: 0
        val remaining = group.remaining ?: 0
        Surface(Modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
            border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border)) {
            Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                    Text("${group.customer ?: "—"}${group.surname?.let { " ($it)" } ?: ""}",
                        style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    if (group.hasReview == true) Text("REVIEW", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.error)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
                    Text("RECEIVED $received", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
                    Text("STORED $stored", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
                    Text("LEFT $remaining", style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
                }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    group.containers.forEach { container ->
                        ContainerCard(
                            code = container.code ?: "—",
                            current = container.current ?: 0,
                            capacity = container.capacity ?: 0,
                            status = container.status ?: "EMPTY",
                            target = state.pending?.targetCode == container.code,
                            flashOk = state.flashOk == container.code,
                            flashBad = state.flashBad == container.code,
                        )
                    }
                }
            }
        }
    }

    // ---- review lane rows of this section ----
    if (board.reviewItems.isNotEmpty()) {
        Text("REVIEW LANE (${board.reviewItems.size})", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.error)
        board.reviewItems.take(20).forEach { review ->
            Surface(Modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.small,
                border = BorderStroke(TerminalTokens.stroke, TerminalTokens.error)) {
                Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(review.productName ?: review.reference ?: review.sku ?: "unknown product",
                        style = MaterialTheme.typography.bodyMedium)
                    if (review.customerName != null) Text("Customer ${review.customerName}",
                        style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                    if (review.reason != null) Text(review.reason, style = MaterialTheme.typography.bodySmall,
                        color = TerminalTokens.error)
                }
            }
        }
    }

    TsScannerControls(capture, state, model)
}

/** Container card: qty/capacity/status + the amber target / green-ok / red-wrong flash. */
@Composable
private fun ContainerCard(
    code: String, current: Int, capacity: Int, status: String,
    target: Boolean, flashOk: Boolean, flashBad: Boolean,
) {
    val borderColor = when {
        target -> TerminalTokens.warning
        flashOk -> TerminalTokens.success
        flashBad -> TerminalTokens.error
        status == "ACTIVE" -> TerminalTokens.success
        status == "FULL" -> TerminalTokens.muted
        else -> TerminalTokens.border
    }
    val pulse by rememberInfiniteTransition(label = "ts-container-pulse").animateFloat(
        0.6f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "container-pulse")
    Surface(
        Modifier.fillMaxWidth().testTag("TS_CONTAINER_$code"),
        color = if (target) TerminalTokens.warning.copy(alpha = 0.10f) else TerminalTokens.raised,
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(if (target || flashOk || flashBad) 3.dp else TerminalTokens.stroke,
            if (target) borderColor.copy(alpha = pulse) else borderColor),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            Column(Modifier.weight(1f)) {
                Text(code, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                    color = if (target) TerminalTokens.warning else TerminalTokens.text)
                Text("$current / $capacity", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
            }
            if (target) {
                Text("▶ TARGET", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Black),
                    color = TerminalTokens.warning, modifier = Modifier.testTag("TARGET_BADGE"))
            } else {
                Text(status, style = MaterialTheme.typography.labelSmall,
                    color = when (status) {
                        "FULL" -> TerminalTokens.muted
                        "ACTIVE" -> TerminalTokens.success
                        "REVIEW" -> TerminalTokens.error
                        else -> TerminalTokens.border
                    })
            }
        }
    }
}

@Composable
private fun TsScannerControls(capture: ScannerCapture, state: TsStorageState, model: TempStorageViewModel) {
    val enabled = model.captureAllowed
    val statusIcon = when (state.message?.tone) {
        MessageTone.SUCCESS -> TerminalIcon.SUCCESS to TerminalTokens.success
        MessageTone.ERROR -> TerminalIcon.ERROR to TerminalTokens.error
        MessageTone.WARNING -> TerminalIcon.WARNING to TerminalTokens.warning
        else -> TerminalIcon.SCANNER to TerminalTokens.instruction
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        HorizontalDivider(color = TerminalTokens.border)
        when {
            capture.manualOpen -> ManualScan(capture, enabled)
            capture.cameraOpen -> {
                capture.preview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
                SecondaryAction("CANCEL SCAN", capture.cancel, enabled)
            }
            capture.ocrOpen -> OcrScan(capture, enabled)
            else -> {
                Text(if (state.pending != null) "SCAN CONTAINER ${state.pending!!.targetCode}" else "SCAN PRODUCT",
                    style = MaterialTheme.typography.titleMedium, color = TerminalTokens.warning)
                Box(Modifier.fillMaxWidth().height(TerminalTokens.stateIcon), contentAlignment = Alignment.Center) {
                    WorkerIcon(statusIcon.first, "Scanner status", Modifier.size(TerminalTokens.stateIcon), statusIcon.second)
                }
                PrimaryAction("SOFTWARE SCAN", capture.softwareScan, enabled)
                Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    SecondaryAction("USE CAMERA", capture.camera, enabled, Modifier.weight(1f))
                    SecondaryAction("MANUAL CODE", capture.manual, enabled, Modifier.weight(1f))
                }
                SecondaryAction("READ LABEL TEXT (OCR)", capture.ocr, enabled)
            }
        }
    }
}

@Composable
private fun ReportPanel(
    state: TsStorageState, observation: String, onObservation: (String) -> Unit, submit: () -> Unit,
) {
    Surface(Modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.success)) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            Text("RAPPORT DE FIN", style = MaterialTheme.typography.titleMedium, color = TerminalTokens.success)
            Text("Sends the station summary (sections, containers, stored, in-review, exceptions) to Admin → Reports.",
                style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
            TerminalTextInput("OBSERVATION (OPTIONAL)", observation, onObservation, enabled = !state.busy)
            Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                PrimaryAction("SUBMIT RAPPORT DE FIN", submit, !state.busy && !state.reportSent, Modifier.weight(1f))
            }
        }
    }
}
