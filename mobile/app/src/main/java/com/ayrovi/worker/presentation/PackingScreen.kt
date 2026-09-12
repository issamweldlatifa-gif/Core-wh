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
 * PACKING (native, CT40-first) — station 4 of the approved Zebra-class build
 * order, in the SAME unified scanner UX:
 *
 *   SCAN CUSTOMER BIN → complete bin: the shipment is created IMMEDIATELY
 *   (zero-touch — the bin scan IS the pack decision), green verdict flashes
 *   and re-arms; incomplete bin: persistent amber verdict listing exactly
 *   what is missing until BACK — fill the bin and scan it again.
 */
@Composable
fun PackingScreen(
    model: PackingViewModel,
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
        "pack", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader("PACKING", worker, station, connection,
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
            scrollKey = "${state.scanEpoch}",
        ) {
            // Live session context only — the tally and the label of the
            // shipment just packed (to stick on the carton). Never history.
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                Box(Modifier.weight(1f)) {
                    TerminalPanel("PACKED TODAY") {
                        Text("${state.packedToday}", style = MaterialTheme.typography.displaySmall,
                            color = TerminalTokens.success)
                    }
                }
                Box(Modifier.weight(1f)) {
                    TerminalPanel("LAST SHIPMENT") {
                        if (state.lastShipment != null) {
                            BarcodeDisplay(state.lastShipment!!)
                        } else {
                            Text("—", style = MaterialTheme.typography.titleMedium, color = TerminalTokens.muted)
                        }
                    }
                }
            }
            ScannerPanel(
                capture = capture, enabled = model.captureAllowed,
                title = "SCAN CUSTOMER BIN",
                subtitle = "A complete bin packs immediately — the scan is the confirmation.",
                accent = TerminalTokens.success,
                onOpenTools = { scanTools = true },
            )
        }

        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (!scanTools) {
            ScanToolsEdgeButton { scanTools = true }
        }
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        // Green (PACKED) flashes and re-arms; amber (INCOMPLETE) / errors persist until BACK.
        val verdict = state.message
        val verdictShown = verdict != null && verdict.tone != MessageTone.INFO
        if (verdictShown) {
            ScanVerdict(capture = capture,
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
