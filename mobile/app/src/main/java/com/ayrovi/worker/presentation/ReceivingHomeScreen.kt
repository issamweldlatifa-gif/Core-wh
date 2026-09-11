package com.ayrovi.worker.presentation

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
 * RECEIVING — INFORMATION ONLY (UX CORRECTION §2/§5): the worker lands
 * DIRECTLY on the receiving overview — cards and their current statuses:
 *
 *   RECEIVING
 *   ── TO DO    [ Product Card ] [ Carton Card ]   (the dispatched feed)
 *   ── ISSUES   [ open error / discrepancy cards ]  (existing states only)
 *   ── DONE     [ session received tally ]          (existing report data)
 *
 * RECEIVING IS NOT A SCANNER ENTRY POINT: no Product/Carton selection, no
 * scan screen, no camera, no scan/start button, and no automatic redirect
 * to scanning. Scanning lives in the INDEPENDENT Home tools (QR CODE opens
 * the existing unified scanner directly, OCR opens the existing OCR flow) —
 * one tap from Home to the right tool (§9/§10).
 *
 * Backend business logic, success flow, error flow (NOT MATCHED + "The
 * failure was logged.") and logging are untouched — this is navigation/UX
 * correction only (§6/§12).
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
    /**
     * UX CORRECTION §9: one-shot intent applied once the feed is loaded —
     * the HOME "QR CODE" tool lands DIRECTLY in the AUTO scanner
     * (OpenAutoScan) with no intermediate step. Null = normal Receiving.
     */
    openWith: ReceivingHomeIntent? = null,
    /**
     * UX CORRECTION §4: OCR tool entry — opens the EXISTING OCR flow (the
     * same chooser surface the tools drawer opens) as soon as scanning is
     * armed. No new OCR logic.
     */
    ocrFirst: Boolean = false,
    /**
     * UX CORRECTION §3: QR CODE opens the camera IMMEDIATELY on devices
     * without a hardware imager (no Start button, no extra confirmation).
     * CT40 keeps its instant hardware trigger. Default true = production;
     * UI harnesses pass false to pin the trigger layout.
     */
    autoOpenCamera: Boolean = true,
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
    val summary by model.workSummary.collectAsStateWithLifecycle()
    val issue by model.issue.collectAsStateWithLifecycle()
    val industrial = device == WorkerDevice.CT40
    val owner = LocalLifecycleOwner.current

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

    // §9 + STABILITY FIX: apply the tool entry ONCE PER ROUTE ENTRY, and
    // reset a stale lane first — re-opening QR CODE after an earlier session
    // used to resume the OLD lane (old message / last scan = "old page").
    LaunchedEffect(state.loaded, openWith) {
        if (openWith != null && state.loaded) {
            // CONTINUITY: an already-open tool lane is RESUMED exactly as it
            // was — no reset, no re-registration, no pipeline churn (the
            // worker must never have to "sign in" to the scanner again). Only
            // a closed lane (overview / HOME) opens.
            val s = state.step
            if (s != HomeStep.AUTO_SCAN && s != HomeStep.REVIEW_PRODUCT && s != HomeStep.REVIEW_CARTON) {
                model.send(openWith)
            }
        }
    }

    // §2/§5: the ONLY scanner is the AUTO scanner (the HOME QR CODE / OCR
    // tools). Receiving itself never scans and never redirects to a scan.
    // STABILITY FIX: the REVIEW steps BELONG to the tool — the verify in
    // flight must keep rendering in the tool. Dropping to the overview for
    // the verify window was the reported "camera opened, then an old page"
    // flash (and it re-armed the camera-open effect below: the reopen loop).
    val lane = if (state.step in setOf(HomeStep.AUTO_SCAN, HomeStep.REVIEW_PRODUCT, HomeStep.REVIEW_CARTON)) "SCAN" else null
    val capture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "home:${state.step}:${state.scanEpoch}", model::onScan,
        // The PRODUCT lane reads the strict compact SKU shape; the CARTON
        // lane reads carton / tracking identifiers; the AUTO tool reads both
        // with the composite of the SAME two templates (no new shapes). Each
        // lane only ever shape-gates its own identifier family.
        ocrTemplate = if (lane == "SCAN") com.ayrovi.worker.scanner.AutoScanTemplate
        else com.ayrovi.worker.scanner.CompactSkuTemplate,
        hardwareOverride = forceHardwareScanner,
    )

    // §3/§4 + STABILITY: the tool's camera / OCR opens on LANE ENTRY — a
    // fresh composition entering AUTO_SCAN (first open, or a later QR CODE
    // tap that finds the lane still open = resume) or the HOME → tool
    // transition. It NEVER re-opens on the automatic re-arm (REVIEW → SCAN
    // after a read): re-opening onto the SAME label still in front of the
    // lens was the reported shake/flicker loop. After a read, the READY
    // panel's one-tap trigger continues the session on a phone; CT40 keeps
    // its instant hardware trigger.
    var lastToolStep by remember { mutableStateOf<HomeStep?>(null) }
    LaunchedEffect(state.step) {
        val enteredTool = lastToolStep != HomeStep.REVIEW_PRODUCT && lastToolStep != HomeStep.REVIEW_CARTON &&
            state.step == HomeStep.AUTO_SCAN
        if (enteredTool) {
            when {
                ocrFirst -> capture.ocr()
                autoOpenCamera && !capture.hardwareAvailable -> capture.camera()
            }
        }
        lastToolStep = state.step
    }

    Box(Modifier.fillMaxSize()) {
    TerminalShell(
        // §4/§16: Settings is NOT in the header anymore — its ONE entry point
        // is the Home screen. The header stays minimal.
        header = { TerminalHeader(if (lane != null) "SCAN" else "RECEIVING", worker, station, connection, industrial = industrial, onBack = onBack, showSettingsIcon = false) },
        footer = {
            TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
                // ONE back rule: BACK always leaves for the MAIN home — from
                // the scan tool it never detours through the Receiving
                // overview (the reported "passed through receiving, stuck
                // there"). The arrow icon says "back", never "cancel".
                // No CONFIRM/APPROVE button: a valid scan is verified and
                // approved automatically, then the lane re-arms for the
                // next unit. The worker only ever scans.
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                    verticalAlignment = Alignment.CenterVertically) {
                    FooterStatus(connection)
                    SecondaryAction("BACK", { onBack() }, !state.busy, Modifier.weight(1f), icon = TerminalIcon.BACK)
                    // GLARE BOOST: one thumb-sized sun at the far edge — for
                    // harsh-sunlight aisles. Persisted like the glove mode.
                    if (onToggleGlare != null) {
                        GlareFooterAction(glareOn, onToggleGlare)
                    }
                }
            }
        },
        scrollKey = state.step,
    ) {
        when {
            !state.loaded -> LoadingState("OPENING RECEIVING…")
            lane == "SCAN" -> AutoLane(state, capture, model.captureAllowed, { model.send(ReceivingHomeIntent.Retry) })
            else -> ReceivingWorkCenter(state, summary, issue, connection)
        }
    }

        // Camera tools take over the whole screen: fogged background, capture
        // region + BACK only. NO side tools button on this tool (the reported
        // floating side arrow): the lane is ONE surface — READY / camera /
        // result — and the phone trigger button lives in the READY panel.
        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        val verdict = state.message
        val verdictShown = verdict != null && (verdict.tone == MessageTone.SUCCESS || verdict.tone == MessageTone.ERROR)
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        }

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
                // RECEIVING loop: a green MATCH re-arms by itself (zero-touch).
                // 1200ms — the verdict must be SEEN: the reported "camera
                // closes by itself without any indication" was a 250ms flash.
                autoRearmMs = 1200,
                onBack = model.workflow::dismissResult,
            )
        }
    }
}

/**
 * RECEIVING WORK CENTER — the content the worker lands on DIRECTLY (§5/§6):
 * the dispatched cards grouped TO DO / ISSUES / DONE from the data the system
 * already holds, then the existing lane tiles and report shortcut.
 */
@Composable
private fun ReceivingWorkCenter(
    state: com.ayrovi.worker.domain.ReceivingHomeState,
    summary: ReceivingWorkSummary?,
    issue: ReceivingIssueState?,
    connection: String,
) {
    Column(Modifier.fillMaxWidth().testTag("RECEIVING_HOME"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        Text(
            "RECEIVING",
            style = MaterialTheme.typography.headlineSmall,
            letterSpacing = 4.sp,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
        )
        val home = state.home
        // ---------- TO DO: the dispatched cards (existing feed) ----------
        // Information ONLY (§2): the cards show WHAT the system is receiving
        // and its live progress. They never navigate to a scanner.
        val todoProducts = home?.productCards.orEmpty()
        val todoCartons = home?.cartonCards.orEmpty()
        SectionHeader("TO DO", todoProducts.size + todoCartons.size, Modifier.testTag("RECEIVING_TODO"))
        // ONE explicit tag per card: chained testTag() keeps the FIRST one in
        // the semantics config, so the first card carries the _FIRST tag here.
        todoProducts.forEachIndexed { index, card ->
            ReceivingProductCard(card, Modifier.testTag(if (index == 0) "RECEIVING_CARD_PRODUCT_FIRST" else "RECEIVING_CARD_PRODUCT"))
        }
        todoCartons.forEachIndexed { index, card ->
            ReceivingCartonCard(card, Modifier.testTag(if (index == 0) "RECEIVING_CARD_CARTON_FIRST" else "RECEIVING_CARD_CARTON"))
        }

        // ---------- ISSUES: existing error / review states only (§12) ----------
        val needsReview = todoProducts.filter { it.categoryStatus?.equals("NEEDS_REVIEW", ignoreCase = true) == true }
        val hasIssues = issue != null || (summary?.openDiscrepancies ?: 0) > 0 || needsReview.isNotEmpty()
        if (hasIssues) {
            SectionHeader("ISSUES", null, Modifier.testTag("RECEIVING_ISSUES"))
            issue?.let {
                IssueCard(it.title, it.detail, it.code?.let { c -> "Scanned: $c" }, tag = "RECEIVING_ISSUE_MISMATCH")
            }
            val openDiscrepancies = summary?.openDiscrepancies ?: 0
            if (openDiscrepancies > 0) {
                IssueCard("$openDiscrepancies OPEN DISCREPANC${if (openDiscrepancies == 1) "Y" else "IES"}",
                    "Recorded during receiving. The RAPPORT (Home) has the details.",
                    null, tag = "RECEIVING_ISSUE_DISCREPANCIES")
            }
            needsReview.forEach { card ->
                IssueCard("NEEDS REVIEW", "${card.productName ?: card.sku ?: card.reference ?: "Card"} — the category needs review. Ask your supervisor.",
                    card.sku ?: card.reference, tag = "RECEIVING_ISSUE_CATEGORY")
            }
        }

        // ---------- DONE: existing session tally (report data) ----------
        val doneVisible = summary != null &&
            (summary.unitsReceived > 0 || summary.cartonsReceived > 0 || summary.status.equals("COMPLETED", ignoreCase = true))
        if (doneVisible && summary != null) {
            SectionHeader("DONE", null, Modifier.testTag("RECEIVING_DONE"))
            DoneCard(summary)
        }
    }
}

/** Small uppercase group header with an optional count — flat, no nested boxes. */
@Composable
private fun SectionHeader(title: String, count: Int?, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = TerminalTokens.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = TerminalTokens.muted, letterSpacing = 2.sp)
        count?.let { Text("· $it", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.muted) }
        Box(Modifier.weight(1f).height(1.dp).background(TerminalTokens.border))
    }
}

/**
 * One TO DO product card (§8): SKU / reference, live received/expected and
 * status — the whole card is the touch target and opens the EXISTING product
 * lane scanner (the scan still matches itself; no START/CONFIRM is added).
 */
@Composable
private fun ReceivingProductCard(card: com.ayrovi.worker.data.ProductCard, modifier: Modifier = Modifier) {
    val glove = LocalGloveMode.current
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalTokens.surface,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.md), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(TerminalIcon.PRODUCT, "PRODUCT", Modifier.size(22.dp), TerminalTokens.success)
                Text("PRODUCT", style = MaterialTheme.typography.labelLarge, letterSpacing = 2.sp)
                Spacer(Modifier.weight(1f))
                Text(cardStatus(card.received, card.expected), style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
            }
            Text(card.productName ?: card.sku ?: card.reference ?: "PRODUCT", style = MaterialTheme.typography.titleMedium)
            (card.sku ?: card.reference)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = TerminalTokens.muted) }
            if (glove) Spacer(Modifier.height(TerminalTokens.xs))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                QuantityDisplay("EXPECTED", card.expected.toString(), Modifier.weight(1f))
                QuantityDisplay("RECEIVED", card.received.toString(), Modifier.weight(1f))
                QuantityDisplay("REMAINING", card.remaining.toString(), Modifier.weight(1f))
            }
            CardProgress(card.received, card.expected)
        }
    }
}

/**
 * One TO DO carton card (§8): tracking identity + product count + status —
 * opens the EXISTING carton lane scanner.
 */
@Composable
private fun ReceivingCartonCard(card: com.ayrovi.worker.data.CartonCard, modifier: Modifier = Modifier) {
    val glove = LocalGloveMode.current
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalTokens.surface,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.md), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(TerminalIcon.CARTON, "CARTON", Modifier.size(22.dp), TerminalTokens.instruction)
                Text("CARTON", style = MaterialTheme.typography.labelLarge, letterSpacing = 2.sp)
                Spacer(Modifier.weight(1f))
                Text(card.status ?: "TO DO", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
            }
            Text(card.externalCartonId ?: card.reference ?: "CARTON", style = MaterialTheme.typography.titleMedium)
            val tracking = card.suiviCode ?: card.trackingCode ?: card.trackingNumber
            tracking?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary, fontFamily = FontFamily.Monospace) }
            if (glove) Spacer(Modifier.height(TerminalTokens.xs))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                card.productCount?.let { QuantityDisplay("PRODUCTS", it.toString(), Modifier.weight(1f)) }
                if (card.totalCartons > 0) QuantityDisplay("CARTON", "${card.cartonNumber}/${card.totalCartons}", Modifier.weight(1f))
            }
        }
    }
}

/** Presentation of the existing received/expected numbers — no new meaning. */
private fun cardStatus(received: Int, expected: Int): String = when {
    received <= 0 -> "TO DO"
    received < expected -> "IN PROGRESS"
    else -> "COMPLETE"
}

/** Verification-card progress: received share of the open card (hidden when the card has no total). */
@Composable
private fun CardProgress(received: Int, expected: Int) {
    if (expected <= 0) return
    LinearProgressIndicator(
        progress = { (received.coerceAtLeast(0).toFloat() / expected).coerceIn(0f, 1f) },
        modifier = Modifier.fillMaxWidth(),
        color = TerminalTokens.success,
        trackColor = TerminalTokens.raised,
    )
}

/** One ISSUE row (§12): the existing error / review state, rendered flat. */
@Composable
private fun IssueCard(
    title: String,
    detail: String,
    code: String? = null,
    action: String? = null,
    onAction: (() -> Unit)? = null,
    tag: String? = null,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalTokens.surface,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.warning),
        modifier = (tag?.let { Modifier.testTag(it) } ?: Modifier).fillMaxWidth(),
    ) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.md), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(TerminalIcon.WARNING, "ISSUE", Modifier.size(22.dp), TerminalTokens.warning)
                Text(title, style = MaterialTheme.typography.titleSmall)
            }
            Text(detail, style = MaterialTheme.typography.bodyMedium)
            code?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, color = TerminalTokens.muted) }
            if (action != null && onAction != null) {
                SecondaryAction(action, onAction, true, Modifier.padding(top = TerminalTokens.xxs))
            }
        }
    }
}

/** One DONE row (§6): the existing session tally, information only. */
@Composable
private fun DoneCard(summary: ReceivingWorkSummary) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = TerminalTokens.surface,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.success),
        modifier = Modifier.fillMaxWidth().testTag("RECEIVING_DONE_CARD"),
    ) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.md), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(TerminalIcon.SUCCESS, "DONE", Modifier.size(22.dp), TerminalTokens.success)
                Text(summary.sessionCode?.let { "SESSION $it" } ?: "RECEIVED WORK", style = MaterialTheme.typography.titleSmall)
                Spacer(Modifier.weight(1f))
                if (summary.status.equals("COMPLETED", ignoreCase = true)) {
                    Text("COMPLETED", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.success)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                QuantityDisplay("UNITS", "${summary.unitsReceived}/${summary.unitsExpected}", Modifier.weight(1f))
                QuantityDisplay("CARTONS", "${summary.cartonsReceived}/${summary.cartonsExpected}", Modifier.weight(1f))
            }
        }
    }
}

/**
 * One full-width lane tile: a big clear icon + a short label. The whole tile
 * is the touch target (CT40-friendly) and opens its scanner directly. A green
 * dot marks a lane with open work; a disabled tile names its reason.
 */
@Composable
internal fun LaneTile(
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

/** AUTO lane (HOME "QR CODE" tool): ONE scanner — a product OR carton read matches itself. */
@Composable
private fun AutoLane(state: com.ayrovi.worker.domain.ReceivingHomeState, capture: ScannerCapture, enabled: Boolean, onRetry: () -> Unit) {
    // NO intro card, NO info notice: the tool opens straight on READY (the
    // reported "opens with introductions"). Errors keep their full-screen
    // surfaces; the panel title is the only text above READY.
    Column(Modifier.fillMaxWidth().testTag("AUTO_SCANNER"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        when {
            // The AUTO tool reuses the EXISTING review panels: what the worker
            // sees after a match is exactly what the dedicated lanes show.
            state.step == HomeStep.REVIEW_PRODUCT -> state.productReview?.let { ProductReviewPanel(it) }
            state.step == HomeStep.REVIEW_CARTON -> state.cartonReview?.let { CartonReviewPanel(it) }
            else -> ScannerArea(capture, enabled, state.productReview != null || state.cartonReview != null,
                onRetry, lastScan = lastScanOf(state))
        }
    }
}

/** MATCHED PRODUCT review — the exact panel the PRODUCT lane always showed (unchanged). */
@Composable
private fun ProductReviewPanel(review: com.ayrovi.worker.domain.HomeProductReview) {
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

/** CARTON RECEIVING review — the exact panel the CARTON lane always showed (unchanged). */
@Composable
private fun CartonReviewPanel(review: com.ayrovi.worker.domain.HomeCartonReview) {
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

/**
 * Scanner area — the SAME unified component as every other station (§14/§26):
 * READY TO SCAN + CT40 indication. A failed attempt keeps RETRY for the exact
 * same scan. (The side tools drawer is NOT part of this tool: one surface.)
 */
@Composable
private fun ScannerArea(
    capture: ScannerCapture, enabled: Boolean, canRetry: Boolean, onRetry: () -> Unit,
    lastScan: LastScan? = null,
) {
    // The retry slot is typed explicitly so the composable lambda keeps its
    // @Composable contract when it is null.
    val retrySlot: (@Composable () -> Unit)? =
        if (canRetry) ({ PrimaryAction("RETRY LAST SCAN", onRetry, enabled, Modifier.testTag("LANE_RETRY")) }) else null
    ScannerPanel(
        capture = capture,
        enabled = enabled,
        title = "SCAN PRODUCT OR CARTON",
        extra = retrySlot,
        accent = TerminalTokens.instruction,
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
