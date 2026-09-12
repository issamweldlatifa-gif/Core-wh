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
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size

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
    /**
     * Deterministic hardware override for instrumented tests (null = sense
     * the real device). Production never passes this.
     */
    forceHardwareScanner: Boolean? = null,
    gloveOn: Boolean = false,
    onToggleGlove: (() -> Unit)? = null,
    /** GLARE BOOST — extreme-contrast palette for harsh sunlight aisles. */
    glareOn: Boolean = false,
    onToggleGlare: (() -> Unit)? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val owner = LocalLifecycleOwner.current
    var settings by remember { mutableStateOf(false) }
    var reportOpen by remember { mutableStateOf(false) }
    var observation by remember { mutableStateOf("") }
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
        onDispose {
            owner.lifecycle.removeObserver(observer)
            model.setForeground(false)
        }
    }

    val capture = rememberScannerCapture(
        model.scanner, model.captureAllowed,
        "ts:${state.letter}:${state.pending?.targetCode}:${state.scanEpoch}", model::onScan,
        hardwareOverride = forceHardwareScanner,
    )

    Box(Modifier.fillMaxSize()) {
    TerminalShell(
        header = {
            TerminalHeader("TEMP STORAGE", worker, station, connection,
                onBack = if (state.letter != null) ({ model.workflow.goHome() }) else onBack,
                industrial = industrial, onSettings = { settings = true }, showSettingsIcon = false)
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
                    // GLARE BOOST: same shared sun as every station's footer.
                    if (onToggleGlare != null) {
                        GlareFooterAction(glareOn, onToggleGlare)
                    }
                }
            }
        },
        scrollKey = "${state.letter}:${state.pending?.targetCode}:${state.scanEpoch}",
    ) {
        when {
            !state.loaded -> LoadingState("OPENING TEMPORARY STORAGE…")
            state.letter == null -> TsHomeBody(state, model, capture, industrial) { scanTools = true }
            else -> TsBoardBody(state, model, capture, industrial) { scanTools = true }
        }
        // §27: scan RESULTS (SUCCESS/ERROR) are shown in the foreground result
        // card below, never inline — inline messages are instructions only.
        state.message
            ?.takeIf { it.tone == MessageTone.INFO || it.tone == MessageTone.WARNING }
            ?.let { OperationalMessageView(it) }
        if (state.letter == null && state.home?.header?.activeProducts == 0) {
            EmptyState("NO CONFIRMED PRODUCTS", "Nothing is waiting for Temporary Storage yet. Confirm products at Receiving first.")
        }
        if (reportOpen) ReportPanel(state, observation, { observation = it },
            submit = { model.workflow.submitReport(observation.trim().ifEmpty { null }); reportOpen = false })
    }

        // Camera tools take over the whole screen: fogged background, capture
        // region + BACK only. Otherwise the ONE tools button is pinned to the
        // far right edge of the screen.
        val cameraActive = capture.cameraOpen || capture.ocrCameraOpen
        val result = state.message
        val resultShown = result != null && (result.tone == MessageTone.SUCCESS || result.tone == MessageTone.ERROR)
        if (cameraActive) {
            CameraToolOverlay(capture, model.captureAllowed)
        } else if (state.loaded && !scanTools && !resultShown) {
            ScanToolsEdgeButton { scanTools = true }
        }

        // §17: the side drawer overlays the screen (never pushes the work).
        if (scanTools) ScanToolsDrawer(capture, model.captureAllowed, onClose = { scanTools = false })

        // §27/§28: the result stays in the foreground (background dimmed) until
        // BACK — or until a new hardware scan replaces it.
        if (resultShown) {
            ScanVerdict(capture = capture,
                ok = result.tone == MessageTone.SUCCESS,
                title = result.title,
                detail = result.detail,
                lines = listOfNotNull(state.flashOk?.let { "Container $it" }),
                onBack = model.workflow::dismissResult,
            )
        }
    }

    if (settings) {
        WorkerSettingsDialog(
            repository = repository,
            worker = worker, station = station, connection = connection,
            appVersion = appVersion, deviceCode = deviceCode, device = device,
            onSwitchMode = { settings = false; onBack() },
            onClose = { settings = false },
            onChangeDisplay = onToggleTheme,
            gloveOn = gloveOn,
            onToggleGlove = onToggleGlove,
        )
    }
}

@Composable
private fun TsHomeBody(
    state: TsStorageState, model: TempStorageViewModel,
    capture: ScannerCapture, industrial: Boolean,
    onOpenScanTools: () -> Unit,
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
        // §4/§5: sections are INDICATORS, never selection buttons — the scan
        // decides the section (customer → first letter → section → container),
        // so only the letters that actually hold products are shown and one
        // that is finished fades out instead of asking for a tap.
        Text("SECTIONS (${home.sections.size})", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.muted)
        Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            home.sections.forEach { section ->
                SectionIndicator(
                    letter = section.letter ?: "—",
                    active = section.letter != null && section.letter == home.currentSection,
                    stored = section.stored ?: 0,
                    products = section.products ?: 0,
                    customers = section.customers.mapNotNull { c ->
                        val name = c.customer ?: return@mapNotNull null
                        val left = c.remaining ?: 0
                        "$name ${c.received ?: 0}${if (left == 0) " ✓" else ""}"
                    },
                    modifier = Modifier.testTag("TS_SECTION_${(section.letter ?: "?").uppercase()}"),
                )
            }
        }
    }
    ScannerPanel(
        capture = capture, enabled = model.captureAllowed,
        title = "SCAN PRODUCT",
        subtitle = "Scan the product — the system resolves customer → section → target container.",
        onOpenTools = onOpenScanTools,
    )
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

/**
 * Section INDICATOR (§5/§12): a letter chip plus its customers, never a button.
 *
 * - the active section (the one the system is currently filling) is amber and
 *   labelled ACTIVE TARGET;
 * - a section whose customers are all complete fades to [dimAlpha] and reads
 *   COMPLETED — it stops competing for attention while staying readable;
 * - the letter is not selectable: scanning a product of that section is what
 *   navigates the operator there (customer → first letter → section).
 */
@Composable
private fun SectionIndicator(
    letter: String, active: Boolean, stored: Int, products: Int, customers: List<String>,
    modifier: Modifier = Modifier,
) {
    val complete = !active && customers.isNotEmpty() && customers.all { it.endsWith("✓") }
    val dimAlpha = if (complete) 0.45f else 1f
    Surface(modifier = modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.small,
        border = BorderStroke(TerminalTokens.stroke,
            when {
                active -> TerminalTokens.warning
                complete -> TerminalTokens.success.copy(alpha = dimAlpha)
                else -> TerminalTokens.border
            })) {
        Row(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
            Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) {
                Surface(
                    color = when {
                        active -> TerminalTokens.warning
                        complete -> TerminalTokens.success.copy(alpha = dimAlpha)
                        else -> TerminalTokens.primary
                    },
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(letter, Modifier.padding(10.dp),
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Black),
                        color = TerminalTokens.onPrimary.copy(alpha = dimAlpha))
                }
            }
            Column(Modifier.weight(1f)) {
                Text("SECTION $letter", style = MaterialTheme.typography.titleMedium,
                    color = TerminalTokens.text.copy(alpha = dimAlpha))
                if (customers.isNotEmpty()) {
                    Text(customers.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                        color = TerminalTokens.muted.copy(alpha = dimAlpha), maxLines = 2)
                }
                Text("$stored / $products stored", style = MaterialTheme.typography.labelSmall,
                    color = TerminalTokens.muted.copy(alpha = dimAlpha))
            }
            Text(
                when {
                    active -> "ACTIVE TARGET"
                    complete -> "COMPLETED ✓"
                    else -> "WAITING"
                },
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
                color = when {
                    active -> TerminalTokens.warning
                    complete -> TerminalTokens.success.copy(alpha = dimAlpha)
                    else -> TerminalTokens.muted
                },
            )
        }
    }
}

@Composable
private fun TsBoardBody(
    state: TsStorageState, model: TempStorageViewModel,
    capture: ScannerCapture, industrial: Boolean,
    onOpenScanTools: () -> Unit,
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
    } else {
        val current = state.home?.currentSection
        if (current != null && state.letter == current) {
            Text("This section is the ACTIVE TARGET — scan a product to place it.",
                style = MaterialTheme.typography.bodySmall, color = TerminalTokens.warning)
        }
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
                // §6: the customer's progress, in the operator's language
                // ("$stored / $received articles"), never a raw id or ratio.
                ProgressBar(
                    done = stored,
                    total = received,
                    barColor = if (remaining > 0) TerminalTokens.instruction else TerminalTokens.success,
                )
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
                    review.customerName?.let { name ->
                        Text("Customer $name", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
                    }
                    review.reason?.let { reason ->
                        Text(reason, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.error)
                    }
                }
            }
        }
    }

    ScannerPanel(
        capture = capture, enabled = model.captureAllowed,
        title = state.pending?.let { "SCAN CONTAINER ${it.targetCode}" } ?: "SCAN PRODUCT",
        subtitle = state.pending?.let { "Place the product, then scan the highlighted container." }
            ?: "Scan the next product to open its target container.",
        onOpenTools = onOpenScanTools,
    )
}

/**
 * Container card: qty/capacity/status + the amber target / green-ok / red-wrong
 * flash.
 *
 * MASTER ORDER §11: a container that reached its capacity is COMPLETED/LOCKED —
 * it stays visible but DIM (never an active element), so the operator only sees
 * what still needs work. [dimAlpha] lowers the whole card's emphasis.
 */
@Composable
private fun ContainerCard(
    code: String, current: Int, capacity: Int, status: String,
    target: Boolean, flashOk: Boolean, flashBad: Boolean,
) {
    val full = status == "FULL"
    val dim = full && !target
    val dimAlpha = if (dim) 0.45f else 1f
    val borderColor = when {
        target -> TerminalTokens.warning
        flashOk -> TerminalTokens.success
        flashBad -> TerminalTokens.error
        status == "ACTIVE" -> TerminalTokens.success
        full -> TerminalTokens.muted.copy(alpha = dimAlpha)
        else -> TerminalTokens.border
    }
    val pulse by rememberInfiniteTransition(label = "ts-container-pulse").animateFloat(
        0.6f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "container-pulse")
    Surface(
        Modifier.fillMaxWidth().testTag("TS_CONTAINER_$code"),
        color = when {
            target -> TerminalTokens.warning.copy(alpha = 0.10f)
            dim -> TerminalTokens.raised.copy(alpha = 0.55f)
            else -> TerminalTokens.raised
        },
        shape = MaterialTheme.shapes.small,
        border = BorderStroke(
            if (target || flashOk || flashBad) 3.dp else TerminalTokens.stroke,
            if (target) borderColor.copy(alpha = pulse) else borderColor,
        ),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            Column(Modifier.weight(1f)) {
                Text(code, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
                    color = (if (target) TerminalTokens.warning else TerminalTokens.text).copy(alpha = dimAlpha))
                Text("$current / $capacity", style = MaterialTheme.typography.bodySmall,
                    color = TerminalTokens.muted.copy(alpha = dimAlpha))
            }
            if (target) {
                Text("▶ TARGET", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Black),
                    color = TerminalTokens.warning, modifier = Modifier.testTag("TARGET_BADGE"))
            } else {
                Text(
                    if (full) "$status ✓" else status,
                    style = MaterialTheme.typography.labelSmall,
                    color = (when (status) {
                        "FULL" -> TerminalTokens.muted
                        "ACTIVE" -> TerminalTokens.success
                        "REVIEW" -> TerminalTokens.error
                        else -> TerminalTokens.border
                    }).copy(alpha = dimAlpha),
                )
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

/** Thin progress bar used by the customer/container blocks (order §6). */
@Composable
internal fun ProgressBar(
    done: Int,
    total: Int,
    modifier: Modifier = Modifier,
    barColor: Color = TerminalTokens.success,
) {
    val ratio = if (total <= 0) 0f else (done.toFloat() / total.toFloat()).coerceIn(0f, 1f)
    // Palette entries are @Composable getters: read them during composition and
    // hand plain Color values to the Canvas (a DrawScope is not composable).
    val track = TerminalTokens.border
    val fill = barColor
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Canvas(Modifier.fillMaxWidth().height(8.dp)) {
            drawRect(track, Offset.Zero, Size(size.width, size.height))
            drawRect(fill, Offset.Zero, Size(size.width * ratio, size.height))
        }
        Text(
            "$done / $total articles · ${(ratio * 100).toInt()}%",
            style = MaterialTheme.typography.labelSmall,
            color = TerminalTokens.muted,
        )
    }
}
