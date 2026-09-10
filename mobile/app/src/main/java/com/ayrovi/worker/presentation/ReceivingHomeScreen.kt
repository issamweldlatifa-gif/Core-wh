package com.ayrovi.worker.presentation

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
 * RECEIVING HOME — worker-first: two lane tiles + the report shortcut + BACK.
 *
 *   ┌─────────────────┐
 *   │     ▌▌▌         │   PRODUCT → ProductScanner (direct, no intermediate page)
 *   │     PRODUCT     │
 *   └─────────────────┘
 *   ┌─────────────────┐
 *   │     ▣           │   CARTON  → CartonScanner (direct, no intermediate page)
 *   │     CARTON      │
 *   └─────────────────┘
 *   [ REPORT ]            → confirmation report (end of work)
 *   [ BACK ]              → previous Worker App screen
 *
 * A green dot marks a lane with open work; a disabled tile names its reason.
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
    /**
     * Deterministic hardware override for instrumented tests (null = sense
     * the real device). Production never passes this.
     */
    forceHardwareScanner: Boolean? = null,
    /** Glove mode (wired from the persisted appearance preference). */
    gloveOn: Boolean = false,
    onToggleGlove: (() -> Unit)? = null,
    /** GLARE BOOST — extreme-contrast palette for harsh sunlight aisles. */
    glareOn: Boolean = false,
    onToggleGlare: (() -> Unit)? = null,
    /** First-run coach marks (shown once per install, then never again). */
    coachPending: Boolean = false,
    onCoachDone: (() -> Unit)? = null,
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
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station, connection, industrial = industrial, onBack = onBack, onSettings = { settings = true }) },
        footer = {
            TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                // BACK leaves RECEIVING for the previous screen; inside a lane
                // it returns to the two tiles without cancelling a completed
                // scan. The arrow icon says "back", never "cancel".
                // No CONFIRM/APPROVE button: a valid scan is verified and
                // approved automatically, then the lane re-arms for the
                // next unit. The worker only ever scans.
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                    verticalAlignment = Alignment.CenterVertically) {
                    FooterStatus(connection)
                    SecondaryAction(if (lane != null) "BACK TO RECEIVING" else "BACK", {
                        if (lane != null) model.send(ReceivingHomeIntent.BackHome) else onBack()
                    }, !state.busy, Modifier.weight(1f), icon = TerminalIcon.BACK)
                    // GLARE BOOST: one thumb-sized sun at the far edge — for
                    // harsh-sunlight aisles. Persisted like the glove mode.
                    if (onToggleGlare != null) {
                        Box(
                            Modifier
                                .size(TerminalTokens.touch)
                                .background(if (glareOn) TerminalTokens.warning.copy(alpha = 0.16f) else Color.Transparent)
                                .border(2.dp, if (glareOn) TerminalTokens.warning else TerminalTokens.border, MaterialTheme.shapes.small)
                                .testTag("GLARE_BUTTON")
                                .clickable { onToggleGlare() },
                            contentAlignment = Alignment.Center,
                        ) {
                            WorkerIcon(TerminalIcon.GLARE, null, Modifier.size(26.dp),
                                if (glareOn) TerminalTokens.warning else TerminalTokens.muted)
                        }
                    }
                }
            }
        },
        scrollKey = state.step,
    ) {
        when {
            !state.loaded -> LoadingState("OPENING RECEIVING…")
            lane == "PRODUCT" -> ProductLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) }, { scanTools = true })
            lane == "CARTON" -> CartonLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) }, { scanTools = true })
            else -> HomeDashboard(state, connection,
                openProduct = { model.send(ReceivingHomeIntent.OpenProduct) },
                openCarton = { model.send(ReceivingHomeIntent.OpenCarton) },
                onOpenReport = onOpenReport)
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
                gloveOn = gloveOn,
                onToggleGlove = onToggleGlove,
                glareOn = glareOn,
                onToggleGlare = onToggleGlare,
            )
        }
    }

        // Camera tools take over the whole screen: fogged background, capture
        // region + BACK only. Otherwise, while a lane scanner is on screen, the
        // ONE tools button is pinned to the far right edge of the screen.
        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        val verdict = state.message
        val verdictShown = verdict != null && (verdict.tone == MessageTone.SUCCESS || verdict.tone == MessageTone.ERROR)
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (lane != null && !scanTools && !verdictShown) {
            ScanToolsEdgeButton { scanTools = true }
        }

        // §17: side drawer overlays the screen; the work interface is untouched.
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        // Phase D (lite): first-minute coach marks — once per install, then
        // never again. Three lines, one GOT IT, no training session needed.
        if (coachPending && onCoachDone != null) {
            CoachMarks(onDone = onCoachDone)
        }

        // §27/§28: the scan verdict stays in the foreground until BACK (no
        // timer), and the next hardware scan replaces it.
        if (verdictShown) {
            ScanResultOverlay(
                ok = verdict!!.tone == MessageTone.SUCCESS,
                title = verdict.title,
                detail = verdict.detail,
                onBack = model.workflow::dismissResult,
            )
        }
    }
}

/** RECEIVING HOME — the title, the two lane tiles, the report shortcut, nothing else. */
@Composable
private fun HomeDashboard(
    state: com.ayrovi.worker.domain.ReceivingHomeState,
    connection: String,
    openProduct: () -> Unit,
    openCarton: () -> Unit,
    onOpenReport: (() -> Unit)?,
) {
    Column(Modifier.fillMaxWidth().testTag("RECEIVING_HOME"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        Text(
            "RECEIVING",
            style = MaterialTheme.typography.headlineSmall,
            letterSpacing = 4.sp,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        // Live dots only (no counters, no lists): a dot means open work is
        // waiting in that lane right now.
        val home = state.home
        val productOpen = home != null && (home.productCards.any { it.remaining > 0 } || home.productCardsPending > 0)
        val cartonOpen = home != null && (home.cartonList.any { it.remaining > 0 } || home.cartonCardsPending > 0 ||
            (home.cartonCards.isNotEmpty() && home.cartonList.isEmpty()))
        val reason = tileReason(state, connection)
        LaneTile("PRODUCT", TerminalIcon.PRODUCT, state.canMutate, openProduct, Modifier.testTag("HOME_PRODUCT_TILE"),
            dot = productOpen, reason = reason)
        LaneTile("CARTON", TerminalIcon.CARTON, state.canMutate, openCarton, Modifier.testTag("HOME_CARTON_TILE"),
            dot = cartonOpen, reason = reason)
        // End-of-work shortcut: the confirmation report, one tap away.
        // Hidden in harnesses where no report destination is wired.
        if (onOpenReport != null) {
            SecondaryAction("REPORT", onOpenReport, !state.busy, Modifier.testTag("HOME_REPORT_BUTTON"), icon = TerminalIcon.REPORT)
        }
    }
}

/** One-line reason a tile is disabled (null = enabled, nothing shown). */
private fun tileReason(state: com.ayrovi.worker.domain.ReceivingHomeState, connection: String): String? {
    if (state.canMutate) return null
    return when {
        state.authExpired -> "SESSION EXPIRED"
        !state.authorized -> "NO PERMISSION"
        connection == "OFFLINE" || !state.serverAvailable -> "OFFLINE"
        state.busy -> "PLEASE WAIT"
        else -> "UNAVAILABLE"
    }
}

/**
 * One full-width lane tile: a big clear icon + a short label. The whole tile
 * is the touch target (CT40-friendly) and opens its scanner directly. A green
 * dot marks a lane with open work; a disabled tile names its reason.
 */
@Composable
private fun LaneTile(
    label: String, icon: TerminalIcon, enabled: Boolean, onOpen: () -> Unit, modifier: Modifier = Modifier,
    dot: Boolean = false, reason: String? = null,
) {
    val glove = LocalGloveMode.current
    Box(modifier) {
        Surface(
            onClick = onOpen,
            enabled = enabled,
            shape = MaterialTheme.shapes.medium,
            color = TerminalTokens.surface,
            border = BorderStroke(TerminalTokens.stroke, if (enabled) TerminalTokens.border else TerminalTokens.muted),
        ) {
            Column(
                Modifier.fillMaxWidth().heightIn(min = if (glove) 144.dp else 128.dp).padding(TerminalTokens.md),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                WorkerIcon(icon, label, Modifier.size(if (glove) 72.dp else 64.dp), TerminalTokens.primary)
                Spacer(Modifier.height(TerminalTokens.xs))
                Text(label, style = MaterialTheme.typography.headlineSmall, letterSpacing = 3.sp)
                if (!enabled && reason != null) {
                    Text(reason, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
                }
            }
        }
        // Open-work dot: decorative (no text), top-end corner of the tile.
        if (dot && enabled) {
            Box(Modifier.align(Alignment.TopEnd).padding(TerminalTokens.sm).size(12.dp)
                .background(TerminalTokens.success, MaterialTheme.shapes.small))
        }
    }
}

/** PRODUIT lane: scanner area + device match/review. Product matching ONLY. */
@Composable
private fun ProductLane(state: com.ayrovi.worker.domain.ReceivingHomeState, capture: ScannerCapture, enabled: Boolean, onRetry: () -> Unit, onOpenScanTools: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("PRODUCT_SCANNER"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        state.message?.takeIf { it.tone == MessageTone.INFO }?.let { OperationalMessageViewHome(it) }
        if (state.step == HomeStep.REVIEW_PRODUCT) {
            state.productReview?.let { review ->
                TerminalPanel("MATCHED PRODUCT CARD", icon = TerminalIcon.CHECK, borderTone = TerminalTone.SUCCESS) {
                    ProductBlock(review.card.productName, review.card.sku ?: review.card.reference ?: review.scan.value)
                    ReviewProgress(review.card.received, review.card.expected)
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
            ScannerArea(capture, enabled, state.productReview != null, onRetry, lane = "PRODUCT", onOpenTools = onOpenScanTools,
                lastScan = lastScanOf(state))
        }
    }
}

/** CARTON lane: scanner area + device match/review. Carton matching ONLY. */
@Composable
private fun CartonLane(state: com.ayrovi.worker.domain.ReceivingHomeState, capture: ScannerCapture, enabled: Boolean, onRetry: () -> Unit, onOpenScanTools: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("CARTON_SCANNER"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        state.message?.takeIf { it.tone == MessageTone.INFO }?.let { OperationalMessageViewHome(it) }
        if (state.step == HomeStep.REVIEW_CARTON) {
            state.cartonReview?.let { review ->
                TerminalPanel("CARTON RECEIVING — ${review.card.entityType ?: "CARTON"}", icon = TerminalIcon.CARTON, borderTone = TerminalTone.SUCCESS) {
                    LocationBlock(review.card.externalCartonId ?: review.scan.value, label = "CARTON TO RECEIVE")
                    ReviewProgress(review.card.cartonNumber, review.card.totalCartons)
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
                    Text("Auto verifying → Auto approving → Next carton", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.success)
                    Text("Recording this carton as received. It cannot be counted twice.", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                }
            }
        } else {
            ScannerArea(capture, enabled, state.cartonReview != null, onRetry, lane = "CARTON", onOpenTools = onOpenScanTools,
                lastScan = lastScanOf(state))
        }
    }
}

/**
 * Scanner area — the SAME unified component as every other station (§14/§26):
 * READY TO SCAN + CT40 indication + one side tools button. The camera / OCR /
 * manual tools live in the drawer and close themselves after a read. A failed
 * attempt keeps RETRY for the exact same scan.
 */
@Composable
private fun ScannerArea(
    capture: ScannerCapture, enabled: Boolean, canRetry: Boolean, onRetry: () -> Unit,
    lane: String, onOpenTools: () -> Unit, lastScan: LastScan? = null,
) {
    // The retry slot is typed explicitly so the composable lambda keeps its
    // @Composable contract when it is null.
    val retrySlot: (@Composable () -> Unit)? =
        if (canRetry) ({ PrimaryAction("RETRY LAST SCAN", onRetry, enabled, Modifier.testTag("LANE_RETRY")) }) else null
    ScannerPanel(
        capture = capture,
        enabled = enabled,
        title = if (lane == "CARTON") "SCAN CARTON" else "SCAN PRODUCT",
        extra = retrySlot,
        onOpenTools = onOpenTools,
        // Green = PRODUCT, blue = CARTON: instant lane recognition.
        accent = if (lane == "CARTON") TerminalTokens.instruction else TerminalTokens.success,
        lastScan = lastScan,
    )
}

/** Maps the workflow's last read to the scanner reminder (verdict mark included). */
private fun lastScanOf(state: com.ayrovi.worker.domain.ReceivingHomeState): LastScan? {
    val value = state.lastScanValue ?: return null
    val at = state.lastScanAt ?: return null
    val tone = state.message?.takeIf {
        it.scanned != null && com.ayrovi.worker.domain.CardMatcher.sameCode(it.scanned, value)
    }?.tone
    return LastScan(value, at, tone)
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

/**
 * Thumb-zone status cluster: a connection dot (green = ONLINE; any other
 * state names itself) plus a silent low-battery flag under 15%. No sound,
 * no dialog — the header keeps the full connection line.
 */
@Composable
/**
 * Phase D (lite): the first minute on the floor — three rules, one tap,
 * then never again. No paragraph walls, no duplicated headers: the Zebra
 * onboarding pattern (explain by doing, get out of the way).
 */
@Composable
private fun CoachMarks(onDone: () -> Unit) {
    Box(
        Modifier.fillMaxSize().testTag("COACH_MARKS")
            .background(TerminalTokens.background.copy(alpha = 0.97f)),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(TerminalTokens.lg),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.md),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("FIRST MINUTE ON THE FLOOR", style = MaterialTheme.typography.titleLarge,
                letterSpacing = 3.sp, textAlign = TextAlign.Center)
            CoachRule(TerminalIcon.PRODUCT, "A matched scan IS the confirmation. Just keep scanning.")
            CoachRule(TerminalIcon.SUCCESS, "GREEN flash = received · RED = stopped — scan again or call your supervisor.")
            CoachRule(TerminalIcon.GLARE, "Sun in your eyes? Tap the ☀ button in the footer for GLARE BOOST.")
            Spacer(Modifier.height(TerminalTokens.xs))
            PrimaryAction("GOT IT — START SCANNING", onDone, true, Modifier.testTag("COACH_OK"))
        }
    }
}

@Composable
private fun CoachRule(icon: TerminalIcon, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        WorkerIcon(icon, null, Modifier.size(34.dp), TerminalTokens.primary)
        Text(text, style = MaterialTheme.typography.bodyLarge, color = TerminalTokens.text)
    }
}

private fun FooterStatus(connection: String) {    val online = connection == "ONLINE"
    val battery = rememberBatteryPct()
    Row(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.heightIn(min = TerminalTokens.touch).testTag("FOOTER_STATUS")) {
        Box(Modifier.size(12.dp).background(
            if (online) TerminalTokens.success else TerminalTokens.warning, MaterialTheme.shapes.small))
        if (!online) {
            Text(connection, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.warning)
        }
        if (battery != null && battery < 15) {
            Text("BATT $battery%", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.warning)
        }
    }
}

/** Sticky battery level (0–100) or null when unreadable — never crashes, never asks permission. */
@Composable
private fun rememberBatteryPct(): Int? {
    val context = LocalContext.current
    return remember {
        runCatching {
            val intent = context.applicationContext.registerReceiver(null,
                android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) (level * 100 / scale) else null
        }.getOrNull()
    }
}

/** Verification-card progress: received share of the open card (hidden when the card has no total). */
@Composable
private fun ReviewProgress(received: Int, expected: Int) {
    if (expected <= 0) return
    Column(Modifier.fillMaxWidth().testTag("REVIEW_PROGRESS"),
        verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
        LinearProgressIndicator(
            progress = { (received.coerceAtLeast(0).toFloat() / expected).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth(),
            color = TerminalTokens.success,
            trackColor = TerminalTokens.raised,
        )
        Text("RECEIVED $received / $expected", style = MaterialTheme.typography.labelMedium,
            color = TerminalTokens.muted)
    }
}
