package com.ayrovi.worker.presentation

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.HomeStep
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.scanner.ScannerCapture
import com.ayrovi.worker.scanner.WorkerDevice
import com.ayrovi.worker.scanner.rememberScannerCapture

/**
 * RECEIVING HOME — worker-first, two choices only.
 *
 *   ┌─────────────────┐
 *   │      📦         │   PRODUCT → ProductScanner (direct, no intermediate page)
 *   │     PRODUCT     │
 *   └─────────────────┘
 *   ┌─────────────────┐
 *   │      ▣          │   CARTON  → CartonScanner (direct, no intermediate page)
 *   │     CARTON      │
 *   └─────────────────┘
 *   [ BACK ]              → previous Worker App screen (the only extra action)
 *
 * No scan buttons, no tool buttons, no scanner and no card lists on this
 * screen. Each tile opens its lane-specific unified scanner directly
 * (PRODUCT scanner → product cards only; CARTON scanner → carton cards only);
 * the scan matches automatically on the device. Business logic, workflow,
 * API contracts and reports are untouched — this rebuild is UX only.
 *
 * Shared by Phone and CT40: same components, state and intents. The CT40
 * physical trigger fires the ACTIVE scanner — the lane determines which
 * matcher is used, so a product lane trigger can never match a carton.
 */
@Composable
fun ReceivingHomeScreen(
    model: ReceivingHomeViewModel,
    worker: String,
    station: String?,
    connection: String,
    onBack: () -> Unit,
    onAuthExpired: () -> Unit,
    device: WorkerDevice = WorkerDevice.PHONE,
    onToggleTheme: (() -> Unit)? = null,
    appVersion: String = "",
    deviceCode: String = "",
    repository: com.ayrovi.worker.data.WorkerRepository? = null,
    onOpenReport: (() -> Unit)? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val industrial = device == WorkerDevice.CT40
    val owner = LocalLifecycleOwner.current
    var settings by remember { mutableStateOf(false) }
    var scanTools by remember { mutableStateOf(false) }

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
        onDispose { owner.lifecycle.removeObserver(observer); model.setForeground(false) }
    }

    LaunchedEffect(state.authExpired) { if (state.authExpired) onAuthExpired() }

    val lane = when (state.step) {
        HomeStep.PRODUCT_SCAN, HomeStep.REVIEW_PRODUCT -> "PRODUCT"
        HomeStep.CARTON_SCAN, HomeStep.REVIEW_CARTON -> "CARTON"
        else -> null
    }
    val capture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "home:${state.step}:${state.scanEpoch}", model::onScan,
        // The PRODUCT lane reads the strict compact SKU shape; the CARTON
        // lane reads carton / tracking identifiers. Each lane only ever
        // shape-gates its own identifier family.
        ocrTemplate = when (lane) {
            "CARTON" -> com.ayrovi.worker.scanner.CartonTemplate
            else -> com.ayrovi.worker.scanner.CompactSkuTemplate
        },
    )

    Box(Modifier.fillMaxSize()) {
    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station, connection, industrial = industrial, onBack = onBack, onSettings = { settings = true }) },
        footer = {
            TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                // BACK is the only action here: on the home it leaves RECEIVING
                // for the previous Worker App screen; inside a lane it returns
                // to the two tiles without cancelling a completed scan.
                // No CONFIRM/APPROVE button: a valid scan is verified and
                // approved automatically, then the lane re-arms for the
                // next unit. The worker only ever scans.
                SecondaryAction(if (lane != null) "BACK TO RECEIVING" else "BACK", {
                    if (lane != null) model.send(ReceivingHomeIntent.BackHome) else onBack()
                }, !state.busy)
            }
        },
        scrollKey = state.step,
    ) {
        when {
            !state.loaded -> LoadingState("OPENING RECEIVING…")
            lane == "PRODUCT" -> ProductLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) }, { scanTools = true })
            lane == "CARTON" -> CartonLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) }, { scanTools = true })
            else -> HomeDashboard(state.canMutate,
                openProduct = { model.send(ReceivingHomeIntent.OpenProduct) },
                openCarton = { model.send(ReceivingHomeIntent.OpenCarton) })
        }
        if (settings) {
            // Shared worker Settings (Send Report / Report a Problem / Switch
            // Mode / clean system info). "Switch Mode" leaves Receiving for
            // the work queue; permissions stay enforced by the backend. When
            // no repository is wired (UI harnesses) the Support actions hide.
            WorkerSettingsDialog(
                repository = repository,
                worker = worker,
                station = station,
                connection = connection,
                appVersion = appVersion,
                deviceCode = deviceCode,
                device = device,
                onSwitchMode = { settings = false; onBack() },
                onClose = { settings = false },
                onChangeDisplay = onToggleTheme,
            )
        }
    }

        // §17: side drawer overlays the screen; the work interface is untouched.
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        // §27/§28: the scan verdict stays in the foreground until BACK (no
        // timer), and the next hardware scan replaces it.
        val verdict = state.message
        if (verdict != null && (verdict.tone == MessageTone.SUCCESS || verdict.tone == MessageTone.ERROR)) {
            ScanResultOverlay(
                ok = verdict.tone == MessageTone.SUCCESS,
                title = verdict.title,
                detail = verdict.detail,
                onBack = model.workflow::dismissResult,
            )
        }
    }
}

/** RECEIVING HOME — the title, the two lane tiles, nothing else. */
@Composable
private fun HomeDashboard(
    canMutate: Boolean,
    openProduct: () -> Unit,
    openCarton: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag("RECEIVING_HOME"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        Text(
            "RECEIVING",
            style = MaterialTheme.typography.headlineSmall,
            letterSpacing = 4.sp,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        LaneTile("PRODUCT", TerminalIcon.RECEIVING, canMutate, openProduct, Modifier.testTag("HOME_PRODUCT_TILE"))
        LaneTile("CARTON", TerminalIcon.PUTAWAY, canMutate, openCarton, Modifier.testTag("HOME_CARTON_TILE"))
    }
}

/**
 * One full-width lane tile: a big clear icon + a short label. The whole tile
 * is the touch target (CT40-friendly) and opens its scanner directly.
 */
@Composable
private fun LaneTile(
    label: String, icon: TerminalIcon, enabled: Boolean, onOpen: () -> Unit, modifier: Modifier = Modifier,
) {
    Surface(
        onClick = onOpen,
        modifier = modifier,
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        color = TerminalTokens.surface,
        border = BorderStroke(TerminalTokens.stroke, if (enabled) TerminalTokens.border else TerminalTokens.muted),
    ) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 128.dp).padding(TerminalTokens.md),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            WorkerIcon(icon, label, Modifier.size(64.dp), TerminalTokens.primary)
            Spacer(Modifier.height(TerminalTokens.xs))
            Text(label, style = MaterialTheme.typography.headlineSmall, letterSpacing = 3.sp)
        }
    }
}

@Composable
internal fun OperationalMessageViewHome(message: OperationalMessage) {
    when (message.tone) {
        MessageTone.ERROR -> ErrorState(message.title, message.detail, message.expected, message.scanned)
        MessageTone.WARNING -> WarningState(message.title, message.detail + (message.scanned?.let { "\nScanned: $it" } ?: ""))
        MessageTone.SUCCESS -> TerminalNotice(message.title, message.detail, TerminalTone.SUCCESS)
        MessageTone.INFO -> TerminalNotice(message.title, message.detail, TerminalTone.INSTRUCTION)
    }
}
