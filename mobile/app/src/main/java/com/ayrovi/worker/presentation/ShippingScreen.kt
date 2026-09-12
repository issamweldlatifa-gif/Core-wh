package com.ayrovi.worker.presentation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.ScannerCapture
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/**
 * SHIPPING (native, CT40-first) — station 5. Dispatch is irreversible, so
 * this is the ONE station with a deliberate confirm button: scan the
 * shipment label → cards (shipment / destination / contents) → CONFIRM
 * DISPATCH → green flash, auto re-arm. Already-shipped = persistent amber.
 */
@Composable
fun ShippingScreen(
    model: ShippingViewModel,
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
        "ship:${state.view?.code}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
        TerminalShell(
            header = {
                TerminalHeader("SHIPPING", worker, station, connection,
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
            scrollKey = "${state.view?.code}:${state.scanEpoch}",
        ) {
            val v = state.view
            if (v == null) {
                ScannerPanel(
                    capture = capture, enabled = model.captureAllowed,
                    title = "SCAN SHIPMENT",
                    subtitle = "Confirm dispatch for a ready-to-ship carton.",
                    accent = TerminalTokens.instruction,
                    onOpenTools = { scanTools = true },
                )
            } else {
                Column(Modifier.fillMaxWidth().testTag("SHIPMENT_PANEL"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                    TerminalPanel("SHIPMENT", borderTone = TerminalTone.SUCCESS) {
                        BarcodeDisplay(v.code)
                        Text("Carrier ${v.carrier ?: "internal"} · Tracking ${v.trackingNumber ?: "—"}",
                            style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
                    }
                    TerminalPanel("DESTINATION", borderTone = TerminalTone.INSTRUCTION) {
                        Text(v.order?.externalCustomerReference ?: "—",
                            style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                        v.order?.externalOrderReference?.let {
                            Text("Order #$it", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                        }
                    }
                    TerminalPanel("CONTENTS") {
                        Text("${v.articles.size} articles" + (v.container?.code?.let { " · bin $it" } ?: ""),
                            style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                    }
                    PrimaryAction("CONFIRM DISPATCH", { model.confirmDispatch() }, !state.busy,
                        Modifier.testTag("CONFIRM_DISPATCH"), icon = TerminalIcon.CHECK)
                    SecondaryAction("SCAN ANOTHER SHIPMENT", { model.clearView() }, !state.busy)
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
