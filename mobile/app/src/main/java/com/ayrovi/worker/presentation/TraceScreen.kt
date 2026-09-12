package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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
 * ARCHIVE / TRACE (native, CT40-first) — read-only station: scan an article,
 * see its full chain from arrival to tracking. Nothing is ever written here.
 */
@Composable
fun TraceScreen(
    model: TraceViewModel,
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

    val capture: ScannerCapture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "trace:${state.view?.article?.code}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader("ARCHIVE / TRACE", worker, station, connection,
                    industrial = industrial, onBack = onBack, onSettings = { settings = true }, showSettingsIcon = false)
            },
            footer = {
                TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                        verticalAlignment = Alignment.CenterVertically) {
                        FooterStatus(connection)
                        SecondaryAction("BACK", onBack, !state.busy, Modifier.weight(1f), icon = TerminalIcon.BACK)
                        if (onToggleGlare != null) {
                            GlareFooterAction(glareOn, onToggleGlare)
                        }
                    }
                }
            },
            scrollKey = "trace:${state.view?.article?.code}:${state.scanEpoch}",
        ) {
            val v = state.view
            if (v == null) {
                ScannerPanel(
                    capture = capture, enabled = model.captureAllowed,
                    title = "SCAN ARTICLE",
                    subtitle = "See the full history of this item.",
                    accent = TerminalTokens.muted,
                    onOpenTools = { scanTools = true },
                )
            } else {
                Column(
                    Modifier.fillMaxWidth()
                        .testTag("TRACE_PANEL"),
                    verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                ) {
                    TerminalPanel("ARTICLE", borderTone = TerminalTone.INSTRUCTION) {
                        Text(v.article?.sku ?: v.article?.code ?: "—",
                            style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                        v.article?.productName?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                        }
                    }
                    val status = v.article?.status
                    if (status != null) {
                        val tone = when (status) {
                            "SHIPPED" -> TerminalTone.SUCCESS
                            "PACKED", "IN_CUSTOMER_BIN" -> TerminalTone.WARNING
                            "IN_CONTAINER" -> TerminalTone.INSTRUCTION
                            else -> TerminalTone.NEUTRAL
                        }
                        TerminalPanel("CURRENT STATUS", borderTone = tone) {
                            Text(status, style = MaterialTheme.typography.titleLarge, color = tone.color())
                        }
                    }
                    TerminalPanel("TIMELINE") {
                        for ((stage, value) in model.stages(v.trace)) {
                            val done = value != null
                            Row(verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(vertical = 4.dp)) {
                                Box(Modifier.size(12.dp).background(
                                    if (done) TerminalTokens.success else TerminalTokens.muted.copy(alpha = 0.25f),
                                    CircleShape))
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(stage, fontSize = 9.sp, color = TerminalTokens.muted, letterSpacing = 1.sp)
                                    Text(value ?: "—",
                                        fontWeight = if (done) FontWeight.Bold else FontWeight.Normal,
                                        color = if (done) TerminalTokens.text else TerminalTokens.muted,
                                        fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                                }
                            }
                        }
                    }
                    SecondaryAction("TRACE ANOTHER", { model.clearView() }, !state.busy)
                }
            }
        }

        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (!scanTools) {
            ScanToolsEdgeButton { scanTools = true }
        }
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        val verdict = state.message
        val verdictShown = verdict != null && verdict.tone != MessageTone.INFO
        if (verdictShown) {
            ScanVerdict(capture = capture,
                ok = false,
                title = verdict!!.title,
                detail = verdict.detail,
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
