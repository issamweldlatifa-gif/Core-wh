package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.ScannerCapture
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/**
 * CUSTOMER SORTING (native, CT40-first) — the third station on the approved
 * Zebra-class build order, in the SAME unified scanner UX as Receiving/TS:
 *
 *   STEP 1  SCAN ARTICLE      → the backend reveals the destination
 *   STEP 2  SCAN LOCATION     → the location scan IS the confirmation
 *             ↓ green flash, auto re-arm (zero-touch, no confirm button)
 *   stop verdicts (REJECTED / REVIEW / errors) stay full-bleed until BACK,
 *   and the next hardware scan replaces a shown verdict (§28).
 *
 * Live context only (customer + destination cards for the open decision) —
 * no history, no counters beyond the operational STORED tally.
 */
@Composable
fun SortingScreen(
    model: SortingViewModel,
    worker: String,
    station: String?,
    connection: String,
    onBack: () -> Unit,
    onAuthExpired: () -> Unit = {},
    industrial: Boolean,
    repository: com.ayrovi.worker.data.WorkerRepository? = null,
    appVersion: String = "",
    deviceCode: String = "",
    device: WorkerDevice = WorkerDevice.PHONE,
    onToggleTheme: (() -> Unit)? = null,
    forceHardwareScanner: Boolean? = null,
    gloveOn: Boolean = false,
    onToggleGlove: (() -> Unit)? = null,
    glareOn: Boolean = false,
    onToggleGlare: (() -> Unit)? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    var scanTools by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }

    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
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

    val capture: ScannerCapture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "sort:${state.step}:${state.decision?.zone?.code}:${state.scanEpoch}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader("CUSTOMER SORTING", worker, station, connection,
                    industrial = industrial, onBack = onBack, onSettings = { settings = true }, showSettingsIcon = false)
            },
            footer = {
                TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                        verticalAlignment = Alignment.CenterVertically) {
                        FooterStatus(connection)
                        SecondaryAction("BACK", onBack, !state.busy, Modifier.weight(1f), icon = TerminalIcon.BACK)
                        SecondaryAction("REFRESH", { model.dismissResult() }, !state.busy, Modifier.weight(1f),
                            icon = TerminalIcon.REFRESH)
                        if (onToggleGlare != null) {
                            GlareFooterAction(glareOn, onToggleGlare)
                        }
                    }
                }
            },
            scrollKey = "${state.step}:${state.scanEpoch}",
        ) {
            val d = state.decision
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                Box(Modifier.weight(1f)) {
                    TerminalPanel("STEP") {
                        Text(if (state.step == SortingStep.ARTICLE) "1 / 2 · ARTICLE" else "2 / 2 · LOCATION",
                            style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                    }
                }
                Box(Modifier.weight(1f)) {
                    TerminalPanel("STORED") {
                        Text("${state.stored}", style = MaterialTheme.typography.displaySmall, color = TerminalTokens.success)
                    }
                }
            }
            if (state.step == SortingStep.LOCATION && d != null) {
                Column(Modifier.fillMaxWidth().testTag("DESTINATION_PANEL")) {
                TerminalPanel("CUSTOMER", borderTone = TerminalTone.INSTRUCTION) {
                    Text(d.article?.productName ?: d.article?.sku ?: "—",
                        style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                    d.article?.sku?.let { BarcodeDisplay(it) }
                }
                TerminalPanel("DESTINATION", borderTone = TerminalTone.SUCCESS) {
                    Text(d.zone?.code ?: "—", style = MaterialTheme.typography.titleLarge, color = TerminalTokens.success)
                    d.zone?.name?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
                    if (d.suggestedLocations.isNotEmpty()) {
                        Text(d.suggestedLocations.joinToString(" · "), style = MaterialTheme.typography.labelMedium,
                            color = TerminalTokens.muted)
                    }
                }
                }
            }
            SortingArea(
                capture = capture,
                enabled = model.captureAllowed,
                step = state.step,
                decision = d,
                onOpenTools = { scanTools = true },
            )
        }

        // The ONE tools button while a scanner is on screen; camera tools take over.
        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (!scanTools) {
            ScanToolsEdgeButton { scanTools = true }
        }
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        // Verdict: green flashes and re-arms (~250ms); stop verdicts persist until BACK.
        val verdict = state.message
        val verdictShown = verdict != null && verdict.tone != MessageTone.INFO
        if (verdictShown) {
            ScanResultOverlay(
                ok = verdict!!.tone == MessageTone.SUCCESS,
                title = verdict.title,
                detail = verdict.detail,
                autoRearmMs = if (verdict.tone == MessageTone.SUCCESS) 250 else null,
                onBack = model::dismissResult,
            )
        }
        if (settings) {
            WorkerSettingsDialog(
                repository = repository, worker = worker, station = station, connection = connection,
                appVersion = appVersion, deviceCode = deviceCode, device = device,
                onSwitchMode = { settings = false; onBack() }, onClose = { settings = false },
                onChangeDisplay = onToggleTheme, gloveOn = gloveOn, onToggleGlove = onToggleGlove,
                glareOn = glareOn, onToggleGlare = onToggleGlare,
            )
        }
    }
}

@Composable
private fun SortingArea(
    capture: ScannerCapture,
    enabled: Boolean,
    step: SortingStep,
    decision: com.ayrovi.worker.data.SortingResult?,
    onOpenTools: () -> Unit,
) {
    if (step == SortingStep.ARTICLE) {
        ScannerPanel(
            capture = capture, enabled = enabled,
            title = "SCAN ARTICLE",
            subtitle = "The system tells you WHERE it goes.",
            accent = TerminalTokens.instruction,
            onOpenTools = onOpenTools,
        )
    } else {
        ScannerPanel(
            capture = capture, enabled = enabled,
            title = decision?.zone?.code?.let { "SCAN LOCATION · $it" } ?: "SCAN LOCATION",
            subtitle = "Scanning the location stores the article — no confirm button.",
            accent = TerminalTokens.success,
            onOpenTools = onOpenTools,
        )
    }
}

/** Local connection indicator — same look as the other stations' footers. */
@Composable
private fun FooterStatus(connection: String) {
    val online = connection == "ONLINE"
    Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.heightIn(min = TerminalTokens.touch).testTag("FOOTER_STATUS")) {
        Box(Modifier.size(12.dp).background(
            if (online) TerminalTokens.success else TerminalTokens.warning, MaterialTheme.shapes.small))
        if (!online) {
            Text(connection, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.warning)
        }
    }
}
