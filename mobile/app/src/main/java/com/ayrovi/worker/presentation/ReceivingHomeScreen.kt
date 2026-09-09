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
 * RECEIVING HOME (card-based receiving rebuild).
 *
 *   ┌──────── PRODUIT ────────┐   ┌──────── CARTON ────────┐
 *   │ Cards: N      [ SCAN ]  │   │ Cards: N     [ SCAN ]  │
 *   └─────────────────────────┘   └────────────────────────┘
 *
 * RECEIVING never opens the scanner directly. Each SCAN opens a
 * lane-specific scanner (PRODUCT scanner → product cards only; CARTON
 * scanner → carton cards only). The lists are information only — the worker
 * never picks a card; the scan matches it automatically on the device.
 *
 * Shared by Phone and CT40: same components, state and intents; the
 * `industrial` flag only compacts spacing/typography (existing convention).
 * The CT40 physical trigger fires the ACTIVE scanner — the lane determines
 * which matcher is used, so a product lane trigger can never match a carton.
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

    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station, connection, industrial = industrial, onBack = onBack, onSettings = { settings = true }) },
        footer = {
            TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    SecondaryAction(if (lane != null) "BACK TO RECEIVING" else "BACK", {
                        if (lane != null) model.send(ReceivingHomeIntent.BackHome) else onBack()
                    }, !state.busy, Modifier.weight(1f))
                    // No CONFIRM/APPROVE button: a valid scan is verified and
                    // approved automatically, then the lane re-arms for the
                    // next product. The worker only ever scans.
                    SecondaryAction("REFRESH", { model.send(ReceivingHomeIntent.Refresh) }, !state.busy, Modifier.weight(1f))
                }
            }
        },
        scrollKey = state.step,
    ) {
        when {
            !state.loaded -> LoadingState("OPENING RECEIVING…")
            // ORDER 04 — terminal offline state: the feed never arrived, so
            // explain the failure and offer RETRY (never an empty dashboard
            // with zeroed counters, never infinite loading). RETRY re-runs
            // refresh(); the host also re-opens automatically when the
            // server returns.
            !state.serverAvailable && state.home == null -> {
                val offline = state.message ?: OperationalMessage(
                    "CONNECTION UNAVAILABLE", "Check the connection, then RETRY.", MessageTone.ERROR,
                )
                OperationalMessageViewHome(offline)
                PrimaryAction("RETRY", { model.send(ReceivingHomeIntent.Refresh) }, true, Modifier.testTag("HOME_RETRY"))
            }
            lane == "PRODUCT" -> ProductLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) })
            lane == "CARTON" -> CartonLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) })
            else -> HomeDashboard(state, industrial,
                openProduct = { model.send(ReceivingHomeIntent.OpenProduct) },
                openCarton = { model.send(ReceivingHomeIntent.OpenCarton) },
                openReport = onOpenReport)
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
}

/** RECEIVING HOME — the two lane tiles + counters + the visible card lists. */
@Composable
private fun HomeDashboard(
    state: com.ayrovi.worker.domain.ReceivingHomeState,
    industrial: Boolean,
    openProduct: () -> Unit,
    openCarton: () -> Unit,
    openReport: (() -> Unit)? = null,
) {
    val home = state.home
    Column(Modifier.fillMaxWidth().testTag("RECEIVING_HOME"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        if (!industrial) Text("RECEIVING HOME", style = MaterialTheme.typography.titleLarge)
        state.message?.let { OperationalMessageViewHome(it) }

        // The two independent lanes — PRODUIT and CARTON.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            HomeTile("PRODUIT", home?.productCardsPending ?: 0, TerminalIcon.RECEIVING,
                state.canMutate, industrial, Modifier.weight(1f).testTag("HOME_PRODUIT_TILE"))
            HomeTile("CARTON", home?.cartonCardsPending ?: 0, TerminalIcon.PUTAWAY,
                state.canMutate, industrial, Modifier.weight(1f).testTag("HOME_CARTON_TILE"))
        }

        // One dedicated scanner per lane — strict separation.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            PrimaryAction("SCAN PRODUIT", openProduct, state.canMutate, Modifier.weight(1f).testTag("OPEN_PRODUCT"))
            PrimaryAction("SCAN CARTON", openCarton, state.canMutate, Modifier.weight(1f).testTag("OPEN_CARTON"))
        }

        // Confirmation report (ORDER 01): verification view for this worker's
        // open receiving session — read-only once the report is sent.
        if (openReport != null) {
            SecondaryAction("📋 CONFIRMATION REPORT", openReport, state.canMutate, Modifier.testTag("OPEN_REPORT"))
        }

        HomeCardLists(state)
    }
}

/** PRODUIT lane: scanner area + device match/review. Product matching ONLY. */
@Composable
private fun ProductLane(state: com.ayrovi.worker.domain.ReceivingHomeState, capture: ScannerCapture, enabled: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("PRODUCT_SCANNER"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        TaskInstruction("PRODUCT SCANNER", "Scan a product QR / barcode, or read the SKU or reference with OCR.")
        state.message?.let { OperationalMessageViewHome(it) }
        if (state.step == HomeStep.REVIEW_PRODUCT) {
            state.productReview?.let { review ->
                TerminalPanel("MATCHED PRODUCT CARD") {
                    ProductBlock(review.card.productName, review.card.sku ?: review.card.reference ?: review.scan.value)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                        QuantityDisplay("EXPECTED", review.card.expected.toString(), Modifier.weight(1f))
                        QuantityDisplay("RECEIVED", review.card.received.toString(), Modifier.weight(1f))
                        QuantityDisplay("REMAINING", review.card.remaining.toString(), Modifier.weight(1f))
                    }
                    Text("Scanned: ${review.scan.value} · ${review.scan.scanType}", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    Text("Verifying and recording one physical unit automatically...", style = MaterialTheme.typography.bodyMedium)
                }
            }
        } else {
            // A kept review means a VERIFY failed: the lane offers RETRY for
            // the exact same attempt (success clears the review, so the button
            // can never replay a completed scan).
            ScannerArea(capture, enabled, state.message, state.productReview != null, onRetry)
        }
    }
}

/** CARTON lane: scanner area + device match/review. Carton matching ONLY. */
@Composable
private fun CartonLane(state: com.ayrovi.worker.domain.ReceivingHomeState, capture: ScannerCapture, enabled: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("CARTON_SCANNER"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        TaskInstruction("📦 CARTON RECEIVING", "Scan a carton QR / barcode, carton reference, suivi or tracking. Auto verify → Auto approve → Next.")
        state.message?.let { OperationalMessageViewHome(it) }
        if (state.step == HomeStep.REVIEW_CARTON) {
            state.cartonReview?.let { review ->
                TerminalPanel("📦 CARTON RECEIVING — ${review.card.entityType ?: "CARTON"}") {
                    LocationBlock(review.card.externalCartonId ?: review.scan.value, label = "CARTON TO RECEIVE")
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Carton: ${review.card.externalCartonId ?: "—"}", style = MaterialTheme.typography.titleMedium)
                        Text("Suivi: ${review.card.suiviCode ?: review.card.trackingCode ?: review.card.trackingNumber ?: "—"}", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
                        review.card.qrCodeValue?.let { Text("QR: $it", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                        review.card.barcodeValue?.let { Text("Barcode: $it", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                        review.card.productCount?.let { Text("Products: $it", style = MaterialTheme.typography.bodyMedium) }
                        review.card.sourceProject?.let { Text("Source: $it", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted) }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                        QuantityDisplay("MATCHED ON", review.matchedOn, Modifier.weight(1f))
                        QuantityDisplay("CARTON", "${review.card.cartonNumber}/${review.card.totalCartons}", Modifier.weight(1f))
                    }
                    review.card.trackingNumber?.let { Text("TRACKING · $it", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
                    review.card.suiviCode?.let { Text("SUIVI · $it", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
                    Text("Scanned: ${review.scan.value} · ${review.scan.scanType}", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                    Text("✅ Auto verifying → Auto approving → Next carton", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                    Text("Recording this carton as received. It cannot be counted twice.", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                }
            }
        } else {
            ScannerArea(capture, enabled, state.message, state.cartonReview != null, onRetry)
        }
    }
}

/** Scanner/camera + OCR + manual entry — the EXISTING capture stack, unchanged. */
@Composable
private fun ScannerArea(capture: ScannerCapture, enabled: Boolean, verdict: OperationalMessage?, canRetry: Boolean, onRetry: () -> Unit) {
    // Verdict-aware: the idle area always reflects the LAST outcome — green
    // check after a success, red error after a failure — never a static
    // scanner residue. A failed attempt offers RETRY for the same scan; the
    // capture buttons stay so the worker can also scan a new code.
    val statusIcon = when (verdict?.tone) {
        MessageTone.SUCCESS -> TerminalIcon.SUCCESS to TerminalTokens.success
        MessageTone.ERROR -> TerminalIcon.ERROR to TerminalTokens.error
        MessageTone.WARNING -> TerminalIcon.WARNING to TerminalTokens.warning
        else -> TerminalIcon.SCANNER to TerminalTokens.instruction
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        when {
            capture.manualOpen -> ManualScan(capture, enabled)
            capture.cameraOpen -> {
                capture.preview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
                SecondaryAction("CANCEL SCAN", capture.cancel, enabled)
            }
            capture.ocrOpen -> OcrScan(capture, enabled)
            else -> {
                Box(Modifier.fillMaxWidth().height(TerminalTokens.stateIcon), contentAlignment = Alignment.Center) {
                    WorkerIcon(statusIcon.first, "Scanner status", Modifier.size(TerminalTokens.stateIcon), statusIcon.second)
                }
                if (canRetry) PrimaryAction("RETRY LAST SCAN", onRetry, enabled, Modifier.testTag("LANE_RETRY"))
                PrimaryAction("SOFTWARE SCAN", capture.softwareScan, enabled)
                SecondaryAction("USE CAMERA", capture.camera, enabled)
                SecondaryAction("MANUAL CODE", capture.manual, enabled)
                SecondaryAction("READ LABEL TEXT (OCR)", capture.ocr, enabled)
            }
        }
    }
}

@Composable
private fun HomeTile(
    label: String, count: Int, icon: TerminalIcon, enabled: Boolean, industrial: Boolean, modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        color = TerminalTokens.surface,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(TerminalTokens.stroke, if (enabled) TerminalTokens.border else TerminalTokens.muted),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(if (industrial) TerminalTokens.sm else TerminalTokens.md),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(icon, label, Modifier.size(TerminalTokens.workflowIcon), TerminalTokens.primary)
                Text(label, style = MaterialTheme.typography.titleLarge, letterSpacing = 2.sp)
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Text(count.toString(), style = MaterialTheme.typography.displaySmall.copy(fontFamily = FontFamily.Monospace), color = TerminalTokens.primary)
                Text("CARDS", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
            }
        }
    }
}

/** Read-only enumeration of the waiting cards (information only — never a picker). */
@Composable
private fun HomeCardLists(state: com.ayrovi.worker.domain.ReceivingHomeState) {
    val home = state.home ?: return
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        CardListBlock("PRODUIT — ${home.productCardsPending} CARDS",
            emptyText = if (home.productCardsPending == 0) "No product cards waiting." else null) {
            home.productList.take(50).forEachIndexed { i, row ->
                CardRow("#${i + 1}", row.reference ?: "—", listOfNotNull(row.label, row.arrivalCode).joinToString(" · "))
            }
        }
        CardListBlock("📦 CARTON — ${home.cartonCardsPending} CARDS (CARTON FIX)",
            emptyText = if (home.cartonCardsPending == 0) "No carton cards waiting." else null) {
            home.cartonList.take(50).forEachIndexed { i, row ->
                CardRow("#${i + 1}", row.reference ?: "—", listOfNotNull(row.tracking?.let { "SUIVI/TRK $it" }, row.arrivalCode, "📦 CARTON").joinToString(" · "))
            }
        }
    }
}

@Composable
private fun CardListBlock(title: String, emptyText: String?, rows: @Composable () -> Unit) {
    TerminalPanel(title) {
        if (emptyText != null) {
            Text(emptyText, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) { rows() }
        }
    }
}

@Composable
private fun CardRow(number: String, reference: String, meta: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text(number, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted,
            fontFamily = FontFamily.Monospace, modifier = Modifier.width(36.dp))
        Text(reference, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.weight(1f))
        Text(meta, style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted,
            modifier = Modifier.weight(1f), textAlign = TextAlign.End)
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
