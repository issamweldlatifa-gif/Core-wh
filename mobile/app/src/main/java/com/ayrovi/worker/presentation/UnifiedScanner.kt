package com.ayrovi.worker.presentation

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import android.app.Activity
import android.content.ContextWrapper
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ayrovi.worker.design.BarcodeDisplay
import com.ayrovi.worker.design.ErrorState
import com.ayrovi.worker.design.PrimaryAction
import com.ayrovi.worker.design.SecondaryAction
import com.ayrovi.worker.design.TerminalIcon
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.design.WorkerIcon
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.scanner.ScanHistoryEntry
import com.ayrovi.worker.scanner.ScannerCapture
import kotlinx.coroutines.delay

/**
 * MASTER ORDER §§14–35 — ONE unified Scanner UX for the whole Worker app.
 *
 * The scanner screen is not a dashboard and not a tool list (§29): it shows
 * READY TO SCAN + the terminal illustration and NOTHING else — no descriptive
 * sentences, no buttons. The ONE small tools button is pinned to the far right
 * edge of the SCREEN (not to the panel) by the station screen.
 *
 * Camera tools TAKE OVER the screen: the whole background is fogged and only
 * the capture region + a BACK button stay visible — the OCR strip on the full
 * screen width, the QR / barcode square on about half the screen. The tools
 * still close themselves as soon as the read is done (§21).
 *
 * The SAME panel is used by every station that scans — Receiving (product and
 * carton lanes), Temporary Storage, and any future station — so there is no
 * per-station scanner UI left (§14/§30).
 */
@Composable
internal fun ScannerPanel(
    capture: ScannerCapture,
    enabled: Boolean,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    extra: (@Composable () -> Unit)? = null,
    onOpenTools: () -> Unit = {},
    /**
     * Lane accent: a thin bar above the title (green = PRODUCT, blue =
     * CARTON). Null = no bar. Titles themselves always use the text color.
     */
    accent: Color? = null,
    /** Last successful read, shown as a one-line reminder under READY (null = hidden). */
    lastScan: LastScan? = null,
) {
    Column(modifier.fillMaxWidth().testTag("SCANNER_PANEL"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        if (accent != null) Box(Modifier.fillMaxWidth().height(4.dp).background(accent, MaterialTheme.shapes.small))
        Text(title, style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
        subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted) }

        when {
            // Manual entry is a small inline form (kept simple on purpose).
            capture.manualOpen -> ManualScan(capture, enabled)
            // Camera tools take over the whole screen (CameraToolOverlay, drawn
            // at screen level by the station): inline only a quiet placeholder.
            capture.cameraOpen || capture.ocrCameraOpen -> CameraToolPlaceholder()
            // OCR selected but the camera not streaming yet (chooser / typing).
            capture.ocrOpen -> OcrScan(capture, enabled)
            else -> ReadyToScanPanel(capture, enabled, lastScan)
        }

        extra?.invoke()
    }
}

/** Quiet inline placeholder while a camera tool owns the screen above. */
@Composable
private fun CameraToolPlaceholder() {
    Spacer(Modifier.fillMaxWidth().height(120.dp))
}

/** One-line reminder of the last read: value + time + verdict mark (or a neutral dot while verifying). */
internal data class LastScan(val value: String, val atMillis: Long, val tone: MessageTone?)

/**
 * Default state (§15/§19/§29): READY TO SCAN + the terminal illustration only.
 * No descriptive text, no buttons — the operator uses the hardware trigger,
 * and the tools button lives on the screen edge, outside this panel.
 *
 * If the terminal exposes no hardware scanner (emulator / plain phone), a
 * phone illustration is drawn and a small TRIGGER line stays reachable without
 * becoming the default. The trigger button pulses ONCE when the lane opens
 * (a single visual hint, then it stays solid).
 */
@Composable
internal fun ReadyToScanPanel(capture: ScannerCapture, enabled: Boolean, lastScan: LastScan? = null) {
    var showTrigger by remember { mutableStateOf(false) }
    var entered by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(Unit) { entered = true }
    val pulse by animateFloatAsState(if (entered) 1f else 0.35f, tween(700), label = "triggerPulse")
    // No card, no giant rectangle: the illustration is a small visual hint
    // integrated naturally into the lane.
    Column(
        Modifier.fillMaxWidth().testTag("READY_TO_SCAN").padding(vertical = TerminalTokens.sm),
        verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "READY TO SCAN",
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Black),
            color = TerminalTokens.instruction,
        )
        if (capture.hardwareAvailable) Ct40Glyph(available = true) else PhoneGlyph()
        if (lastScan != null) LastScanLine(lastScan)
        if (!capture.hardwareAvailable) {
            if (showTrigger) {
                PrimaryAction("TRIGGER SCAN", capture.softwareScan, enabled,
                    Modifier.graphicsLayer { alpha = pulse }.testTag("SOFTWARE_TRIGGER"))
            } else {
                SecondaryAction("SHOW TRIGGER", { showTrigger = true }, enabled,
                    Modifier.graphicsLayer { alpha = pulse }.testTag("SHOW_TRIGGER"))
            }
        }
    }
}

/** LAST read reminder: `LAST: <value> ✓ 14:32` — replaced by every new scan, never a history. */
@Composable
private fun LastScanLine(scan: LastScan) {
    val (mark, color) = when (scan.tone) {
        MessageTone.SUCCESS -> "✓" to TerminalTokens.success
        MessageTone.ERROR -> "✕" to TerminalTokens.error
        MessageTone.WARNING -> "!" to TerminalTokens.warning
        MessageTone.INFO -> "•" to TerminalTokens.instruction
        null -> "•" to TerminalTokens.muted
    }
    Row(Modifier.fillMaxWidth().testTag("LAST_SCAN"), horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically) {
        Text("LAST: ", style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted)
        Text(scan.value.take(20), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = TerminalTokens.text)
        Text("  $mark ${shortTime(scan.atMillis)}", style = MaterialTheme.typography.bodySmall, color = color)
    }
}

/** Compact local HH:MM stamp for the last-scan reminder. */
private fun shortTime(millis: Long): String = runCatching {
    java.time.Instant.ofEpochMilli(millis).atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
}.getOrDefault("--:--")

/** Small CT40 illustration (§15): device body + side trigger, drawn, not an image. */
@Composable
private fun Ct40Glyph(available: Boolean) {
    val tone = if (available) TerminalTokens.success else TerminalTokens.muted
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier.size(width = 30.dp, height = 52.dp)
                .border(2.dp, tone, MaterialTheme.shapes.small)
                .background(TerminalTokens.raised, MaterialTheme.shapes.small),
            contentAlignment = Alignment.Center,
        ) {
            Text("CT40", style = MaterialTheme.typography.labelSmall.copy(fontSize = 9.sp, fontFamily = FontFamily.Monospace), color = tone)
        }
        // The physical trigger on the side of the terminal.
        Box(Modifier.width(5.dp).height(22.dp).background(tone, MaterialTheme.shapes.small))
    }
}

/** Small phone illustration for terminals without a hardware scanner. */
@Composable
private fun PhoneGlyph() {
    Box(
        Modifier.size(width = 32.dp, height = 58.dp)
            .border(2.dp, TerminalTokens.muted, MaterialTheme.shapes.small)
            .background(TerminalTokens.raised, MaterialTheme.shapes.small),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.width(12.dp).height(3.dp).background(TerminalTokens.muted, MaterialTheme.shapes.small))
    }
}

/**
 * Width of the side button touch target. It is the gloved-touch token
 * (56 dp), so the small button is comfortable to hit one-handed (§31).
 */
private val ToolsRail = 56.dp

/**
 * The single, small, semi-transparent side button (§16). The strip stays small
 * (34 dp) but the touch target is finger-sized (56 × 72 dp) so it is easy to
 * hit with gloves on while the terminal is held one-handed (§31).
 */
@Composable
private fun ScanToolsArrow(modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier.size(width = ToolsRail, height = 72.dp).testTag("SCAN_TOOLS_ARROW").clickable(onClick = onClick),
        contentAlignment = Alignment.CenterEnd,
    ) {
        Surface(
            modifier = Modifier.size(width = 34.dp, height = 64.dp),
            color = TerminalTokens.raised.copy(alpha = 0.55f),
            shape = MaterialTheme.shapes.small,
            border = BorderStroke(1.dp, TerminalTokens.border),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text("◀", style = MaterialTheme.typography.titleMedium, color = TerminalTokens.instruction)
            }
        }
    }
}

/**
 * The tools button, pinned to the far right edge of the SCREEN (§16) — never
 * attached to the scanner panel. The container itself is not clickable, so
 * touches pass through everywhere except on the small button. Drawn at screen
 * level by the station, only while the scanner is on screen and no camera tool
 * owns it.
 */
@Composable
internal fun ScanToolsEdgeButton(onOpenTools: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterEnd) {
        ScanToolsArrow(onClick = onOpenTools)
    }
}

/**
 * Camera tool TAKEOVER. The whole screen is fogged and ONLY the capture region
 * + a BACK button stay visible:
 *
 *  - OCR: one bounded horizontal aperture, centered with black all around
 *    it (NOT screen-sized): the live camera shows ONLY inside that
 *    rectangle — the camera opening the operator aims the SKU line with.
 *    While aiming, nothing else shows; only after a shape-validated code
 *    is detected do the code + CONFIRM appear above the aperture (raw
 *    engine text never shows).
 *  - QR / BARCODE: one square on about HALF the screen, centered. The read
 *    submits itself on decode, so no confirm step is needed.
 */
@Composable
internal fun CameraToolOverlay(capture: ScannerCapture, enabled: Boolean, onBack: (() -> Unit)? = null) {
    val ocr = capture.ocrCameraOpen
    // v76 OWNER MODEL: the tool opens like the PHONE'S OWN CAMERA — edge to
    // edge, the system status bar (clock/battery) hidden until BACK.
    val view = LocalView.current
    if (!ocr) {
        androidx.compose.runtime.DisposableEffect(view) {
            var ctx = view.context
            var window: android.view.Window? = null
            while (ctx is ContextWrapper) {
                if (ctx is Activity) { window = ctx.window; break }
                ctx = ctx.baseContext
            }
            val controller = window?.let { WindowCompat.getInsetsController(it, view) }
            controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(WindowInsetsCompat.Type.statusBars())
            onDispose { controller?.show(WindowInsetsCompat.Type.statusBars()) }
        }
    }
    Box(Modifier.fillMaxSize().testTag(if (ocr) "OCR_SCAN" else "CAPTURE_QR_AREA")) {
        if (ocr) {
            Box(Modifier.fillMaxSize().background(Color.Black)) {
            val candidate = capture.ocrSuggestion?.candidate
            Column(
                Modifier.align(Alignment.Center).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (candidate != null) {
                    // Only the shape-validated code is ever rendered.
                    BarcodeDisplay(candidate)
                    PrimaryAction(
                        "CONFIRM CODE", capture.submitOcr, enabled,
                        Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.lg),
                    )
                } else {
                    capture.ocrError?.let { ErrorState("NO CODE FOUND", it) }
                }
                OcrTakeoverStrip(capture.ocrPreview)
            }
            }
        } else {
            // ---- v77 SCANNER SCREEN (owner layout, supersedes v76) ----
            // UPPER: the LIVE CAMERA only — never the whole screen, never a
            // designed black area: ONE CameraX preview, the scanning frame
            // CENTERED inside it, ✕ + ⚡ kept on top, and the ONE success/
            // failure mark — the verdict circle drawn over the live image.
            // LOWER: the white, visually separated session history.
            Column(Modifier.fillMaxSize().background(Color.Black)) {
                Box(Modifier.fillMaxWidth().weight(1.12f).testTag("CAMERA_AREA")) {
                    // ONE preview (v76 accidentally composed TWO CameraX
                    // previews — the second stayed black on real devices).
                    capture.preview(Modifier.matchParentSize())

                    // Scanning frame: THICK corner brackets, CENTERED in the
                    // camera area (owner order §2-A).
                    BoxWithConstraints(Modifier.matchParentSize(), contentAlignment = Alignment.Center) {
                        val frameW = maxWidth * 0.86f
                        val frameH = maxHeight * 0.34f
                        Box(Modifier.size(frameW, frameH)) {
                            Canvas(Modifier.matchParentSize()) {
                                val w = size.width
                                val h = size.height
                                val arm = w * 0.16f
                                val c = Color.White
                                val stroke = 12f
                                drawLine(c, Offset(0f, 0f), Offset(arm, 0f), strokeWidth = stroke)
                                drawLine(c, Offset(0f, 0f), Offset(0f, arm), strokeWidth = stroke)
                                drawLine(c, Offset(w, 0f), Offset(w - arm, 0f), strokeWidth = stroke)
                                drawLine(c, Offset(w, 0f), Offset(w, arm), strokeWidth = stroke)
                                drawLine(c, Offset(0f, h), Offset(arm, h), strokeWidth = stroke)
                                drawLine(c, Offset(0f, h), Offset(0f, h - arm), strokeWidth = stroke)
                                drawLine(c, Offset(w, h), Offset(w - arm, h), strokeWidth = stroke)
                                drawLine(c, Offset(w, h), Offset(w, h - arm), strokeWidth = stroke)
                            }
                        }
                    }

                    // THE verdict mark (green ✓ / red ✕) — centred IN the
                    // camera, over the live preview, brief and auto-clearing
                    // (the engine in ScannerCaptureHost owns the timing).
                    capture.feedback?.let { fb ->
                        val okMark = fb.success
                        Box(
                            Modifier.align(Alignment.Center).size(112.dp)
                                .background(
                                    (if (okMark) TerminalTokens.success else TerminalTokens.error).copy(alpha = 0.92f),
                                    CircleShape,
                                )
                                .testTag(if (okMark) "SCAN_FEEDBACK_OK" else "SCAN_FEEDBACK_ERR"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (okMark) "✓" else "✕",
                                color = Color.White,
                                style = MaterialTheme.typography.displayLarge,
                                fontWeight = FontWeight.Black,
                            )
                        }
                    }

                    // ✕ CLOSE — top-START (the reference position).
                    Box(
                        Modifier.align(Alignment.TopStart).padding(top = 22.dp, start = 22.dp)
                            .size(46.dp).background(Color.Black.copy(alpha = 0.35f), MaterialTheme.shapes.small)
                            .clickable(enabled = enabled) { (onBack ?: capture.cancel)() }
                            .testTag("TOOL_CLOSE"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("✕", color = Color.White, style = MaterialTheme.typography.titleLarge)
                    }
                    // ⚡ TORCH — top-END: camera light on/off (v76).
                    Box(
                        Modifier.align(Alignment.TopEnd).padding(top = 22.dp, end = 22.dp)
                            .size(46.dp).background(
                                if (capture.torchOn) TerminalTokens.warning.copy(alpha = 0.85f)
                                else Color.Black.copy(alpha = 0.35f),
                                MaterialTheme.shapes.small,
                            )
                            .clickable(enabled = enabled) { capture.toggleTorch() }
                            .testTag("TOOL_TORCH"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("⚡", color = Color.White, style = MaterialTheme.typography.titleLarge)
                    }
                }

                // ---- LOWER: WHITE SCAN HISTORY (permanent, grows per scan) ----
                Column(Modifier.fillMaxWidth().weight(0.88f).background(Color.White)) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.lg, vertical = TerminalTokens.sm),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("SCAN HISTORY", style = MaterialTheme.typography.labelLarge, color = TerminalTokens.text)
                        Text("${capture.history.size}", style = MaterialTheme.typography.labelLarge, color = TerminalTokens.muted)
                    }
                    if (capture.history.isEmpty()) {
                        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Text(
                                "Scan results appear here — nothing is lost.",
                                style = MaterialTheme.typography.bodySmall,
                                color = TerminalTokens.muted,
                            )
                        }
                    } else {
                        Column(
                            Modifier.weight(1f).fillMaxWidth()
                                .verticalScroll(rememberScrollState())
                                .testTag("SCAN_HISTORY"),
                        ) {
                            capture.history.asReversed().forEach { entry -> ScanHistoryRow(entry) }
                        }
                    }
                    HorizontalDivider(color = TerminalTokens.border)
                    // Manual entry — the SAME existing pipeline (never a second
                    // one): "an article WITHOUT a barcode?" → type the code.
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.lg, vertical = TerminalTokens.sm),
                        verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (capture.manualOpen) {
                            androidx.compose.material3.OutlinedTextField(
                                value = capture.manualCode,
                                onValueChange = capture.setCode,
                                enabled = enabled,
                                singleLine = true,
                                label = { Text("TYPE THE CODE", color = TerminalTokens.muted) },
                                textStyle = MaterialTheme.typography.bodyLarge.copy(color = Color.Black),
                                modifier = Modifier.fillMaxWidth().testTag("TOOL_MANUAL_INPUT"),
                            )
                            PrimaryAction(
                                "SUBMIT CODE", capture.submit, enabled && capture.manualCode.isNotBlank(),
                                Modifier.fillMaxWidth().testTag("TOOL_MANUAL_SUBMIT"),
                            )
                        } else {
                            Text(
                                "NO BARCODE ON THE ARTICLE ?",
                                style = MaterialTheme.typography.labelLarge,
                                color = TerminalTokens.text,
                                modifier = Modifier.clickable(enabled = enabled) { capture.manual() }
                                    .testTag("TOOL_MANUAL"),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OcrTakeoverStrip(preview: @Composable (Modifier) -> Unit) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp).height(112.dp)) {
        preview(Modifier.matchParentSize())
        Canvas(Modifier.matchParentSize()) {
            drawRect(
                color = Color.White.copy(alpha = 0.9f),
                topLeft = Offset(2f, 2f),
                size = Size(size.width - 4f, size.height - 4f),
                style = Stroke(width = 3f),
            )
            val midY = size.height / 2f
            drawLine(Color.White.copy(alpha = 0.55f), Offset(10f, midY), Offset(size.width - 10f, midY), strokeWidth = 1.5f)
        }
    }
}



/**
 * Side drawer (§17/§18/§20): QR / BARCODE, OCR, MANUEL, CT40 (hardware
 * terminals only), FERMER. Icon + short label only. Picking a tool closes
 * the drawer immediately and opens that tool; CT40 returns to the
 * hardware-scanner default. On a plain phone the CT40 row is hidden — there
 * is no hardware trigger to return to.
 *
 * COMPACT and proportional: a wrapped panel anchored to the right edge near
 * its control zone — never a full-height wall.
 */
@Composable
internal fun ScanToolsDrawer(capture: ScannerCapture, enabled: Boolean, onClose: () -> Unit) {
    Box(Modifier.fillMaxSize().testTag("SCAN_TOOLS_DRAWER")) {
        // Scrim: tapping outside closes without changing the current mode.
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)).clickable(onClick = onClose),
        )
        Surface(
            Modifier.align(Alignment.CenterEnd).padding(end = TerminalTokens.xs).width(204.dp),
            color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
            border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        ) {
            Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Text("SCAN TOOLS", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.warning)
                DrawerItem("QR / BARCODE", TerminalIcon.CAMERA, "TOOL_QR", enabled) {
                    onClose(); capture.camera()
                }
                DrawerItem("OCR", TerminalIcon.SCANNER, "TOOL_OCR", enabled) {
                    onClose(); capture.ocr(); capture.ocrCamera()
                }
                DrawerItem("MANUEL", TerminalIcon.MANUAL, "TOOL_MANUAL", enabled) {
                    onClose(); capture.manual()
                }
                if (capture.hardwareAvailable) {
                    DrawerItem("CT40", TerminalIcon.CHECK, "TOOL_CT40", enabled) {
                        onClose(); capture.cancel() // back to the hardware scanner default
                    }
                }
                HorizontalDivider(color = TerminalTokens.border)
                DrawerItem("FERMER", TerminalIcon.CLOSE, "TOOL_CLOSE", true) { onClose() }
            }
        }
    }
}

@Composable
private fun DrawerItem(label: String, icon: TerminalIcon, tag: String, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        Modifier.fillMaxWidth().height(52.dp).testTag(tag).clickable(enabled = enabled, onClick = onClick),
        color = TerminalTokens.raised, shape = MaterialTheme.shapes.small,
        border = BorderStroke(1.dp, TerminalTokens.border),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            WorkerIcon(icon, null, Modifier.size(TerminalTokens.iconSmall), if (enabled) TerminalTokens.instruction else TerminalTokens.muted)
            Text(label, style = MaterialTheme.typography.labelLarge,
                color = if (enabled) TerminalTokens.text else TerminalTokens.muted)
        }
    }
}

/**
 * v77 VERDICT ROUTING — the anti-duplication gate the owner ordered.
 *
 * Camera tool OPEN → the verdict becomes the in-camera circle + a history
 * row and NOTHING ELSE is drawn: the v75 success panel (centered mark +
 * white value panel over the viewfinder) is DELETED from this path, so
 * there is exactly ONE success mark — the green ✓ circle centred in the
 * camera. The reason shown is the REAL workflow verdict, never invented.
 *
 * Camera tool CLOSED (hardware CT40 lane, no camera on screen) → the
 * existing full-screen verdict stays: the circle needs a camera to live in.
 */
@Composable
internal fun ScanVerdict(
    capture: ScannerCapture,
    ok: Boolean,
    title: String,
    detail: String,
    lines: List<String> = emptyList(),
    autoRearmMs: Long? = null,
    toneOverride: MessageTone? = null,
    /** The scanned value when the workflow message carries it — the history
     *  row shows the SKU/barcode, not the verdict wording. */
    scannedCode: String? = null,
    /** Per-read identity (e.g. the workflow's scanEpoch). Verdicts can repeat
     *  VERBATIM for consecutive units while this composable stays composed —
     *  without an epoch the LaunchedEffect key would not change and the
     *  second identical verdict would never reach the camera circle. */
    epoch: Any? = null,
    onBack: () -> Unit,
) {
    if (capture.cameraOpen) {
        val key = "$epoch|$title|$detail|${lines.joinToString("|")}"
        LaunchedEffect(key) {
            val success = ok || toneOverride == MessageTone.SUCCESS
            val warning = toneOverride == MessageTone.WARNING
            // Receiving convention: detail carries the scanned value when the
            // message does not.
            val code = scannedCode ?: detail.ifBlank { title }
            val reason = if (lines.isEmpty()) title else "$title · ${lines.joinToString(" · ")}"
            capture.reportVerdict(success, warning, code, reason)
        }
    } else {
        ScanResultOverlay(
            ok = ok,
            title = title,
            detail = detail,
            lines = lines,
            autoRearmMs = autoRearmMs,
            toneOverride = toneOverride,
            onBack = onBack,
        )
    }
}

/** One session-history row: verdict mark, code, REAL reason, time. */
@Composable
private fun ScanHistoryRow(entry: ScanHistoryEntry) {
    val (mark, tone) = when (entry.tone) {
        com.ayrovi.worker.scanner.ScanHistoryTone.SUCCESS -> "✓" to TerminalTokens.success
        com.ayrovi.worker.scanner.ScanHistoryTone.ERROR -> "✕" to TerminalTokens.error
        com.ayrovi.worker.scanner.ScanHistoryTone.WARNING -> "!" to TerminalTokens.warning
        com.ayrovi.worker.scanner.ScanHistoryTone.PENDING -> "•" to TerminalTokens.muted
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.lg, vertical = 6.dp)
            .testTag("SCAN_HISTORY_ITEM"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(mark, style = MaterialTheme.typography.titleMedium, color = tone, modifier = Modifier.width(28.dp))
        Column(Modifier.weight(1f)) {
            Text(
                entry.code,
                style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold),
                color = Color.Black,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                entry.detail,
                style = MaterialTheme.typography.bodySmall,
                color = if (entry.tone == com.ayrovi.worker.scanner.ScanHistoryTone.ERROR) TerminalTokens.error else TerminalTokens.muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(historyTime(entry.atMillis), style = MaterialTheme.typography.labelSmall, color = TerminalTokens.muted)
    }
    HorizontalDivider(color = TerminalTokens.border.copy(alpha = 0.5f), thickness = 0.5.dp)
}

/** Local HH:mm:ss stamp for a history row. */
private fun historyTime(millis: Long): String = runCatching {
    java.time.Instant.ofEpochMilli(millis).atZone(java.time.ZoneId.systemDefault())
        .format(java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss"))
}.getOrDefault("--:--:--")

/**
 * Scan VERDICT — full-bleed, judged from arm's length (Phase B).
 *
 * MATCH (ok = true): the whole screen washes GREEN with a giant check and the
 * verdict — readable under sunlight, from a loaded carry position, without
 * reading text. The flash is momentary (~250ms) and the lane auto-rearms for
 * the next unit; the permanent record lives in the LAST-scan line and the
 * progress bar, so nothing is lost by the auto-clear. This is the operator-
 * approved supersede of the old never-auto-dismiss rule for SUCCESS only.
 *
 * ERROR / stop verdicts: the screen washes RED and STAYS — never
 * auto-dismissed — until BACK or the next hardware scan replaces it (§27/§28).
 */
@Composable
internal fun ScanResultOverlay(
    ok: Boolean,
    title: String,
    detail: String,
    lines: List<String> = emptyList(),
    /** RECEIVING loop only: auto-rearm after a MATCH (ms). Stations whose
     *  standing rule is "the verdict stays until BACK" pass null (default). */
    autoRearmMs: Long? = null,
    /** v1.7.5: explicit verdict tone. WARNING renders the AMBER verdict
     *  ("already scanned / card complete") with the same zero-touch re-arm
     *  loop as a MATCH, so those verdicts are finally SEEN. Default keeps
     *  the historic green/red behaviour for the other stations. */
    toneOverride: MessageTone? = null,
    onBack: () -> Unit,
) {
    val tone = when (toneOverride) {
        MessageTone.SUCCESS -> TerminalTokens.success
        MessageTone.WARNING -> TerminalTokens.warning
        MessageTone.ERROR -> TerminalTokens.error
        else -> if (ok) TerminalTokens.success else TerminalTokens.error
    }
    // GREEN / AMBER = "move on" verdicts: auto-rearm. RED = stop: stays.
    val rearmMs = autoRearmMs?.takeIf { ok || toneOverride == MessageTone.WARNING }
    val moveOn = rearmMs != null
    val mark = when { ok -> "✓"; toneOverride == MessageTone.WARNING -> "!"; else -> "✕" }
    if (rearmMs != null) {
        // MATCH / AMBER: re-arm the lane automatically. The loop never stops.
        LaunchedEffect(title) { delay(rearmMs); onBack() }
    }
    // v1.8-batch.8 (75) OWNER MODEL: "move on" verdicts drop the full-screen
    // wash — the CAMERA VIEWFINDER STAYS VISIBLE and the verdict is an
    // animated circle-check drawn OVER it plus a white panel beneath with the
    // scanned value. STOP verdicts (red) keep the full wash and stay until BACK.
    Box(
        Modifier.fillMaxSize().testTag("SCAN_RESULT").background(
            if (moveOn) Color.Transparent else TerminalTokens.background.copy(alpha = 0.97f),
        ),
    ) {
        if (!moveOn) {
            // Tone wash band across the top half — the color signal seen from
            // arm's length before any text is parsed (stop verdicts only).
            Box(
                Modifier.fillMaxWidth().fillMaxHeight(0.42f)
                    .background(tone.copy(alpha = 0.34f)),
            )
        }
        if (moveOn) {
            Column(
                Modifier.fillMaxSize().padding(TerminalTokens.lg),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                AnimatedVerdictMark(tone, mark)
                Spacer(Modifier.height(TerminalTokens.lg))
                // White panel: WHAT was scanned, big and readable.
                Column(
                    Modifier.fillMaxWidth().background(Color.White, MaterialTheme.shapes.medium)
                        .padding(TerminalTokens.lg).testTag("SCAN_VALUE_PANEL"),
                    verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // Verdict label in the tone colour, then WHAT was scanned.
                    Text(title, style = MaterialTheme.typography.labelLarge, color = tone)
                    if (detail.isNotBlank()) {
                        Text(detail, style = MaterialTheme.typography.displaySmall,
                            color = Color.Black,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                    lines.forEach { line ->
                        Text(line, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                            color = Color.Black)
                    }
                }
                Spacer(Modifier.height(TerminalTokens.md))
                Text("SCAN NEXT — NO TOUCH NEEDED", style = MaterialTheme.typography.labelLarge,
                    color = tone)
            }
        } else {
            Column(
                Modifier.align(Alignment.Center).fillMaxWidth().padding(TerminalTokens.lg),
                verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                WorkerIcon(TerminalIcon.ERROR, null, Modifier.size(72.dp), tone)
                Text(mark, style = MaterialTheme.typography.displayLarge, color = tone)
                Text(title, style = MaterialTheme.typography.displaySmall, color = TerminalTokens.text,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                if (detail.isNotBlank()) {
                    Text(detail, style = MaterialTheme.typography.bodyLarge, color = TerminalTokens.muted,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
                lines.forEach { line ->
                    Text(line, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                        color = TerminalTokens.text)
                }
                Spacer(Modifier.height(2.dp))
                PrimaryAction("BACK", onBack, true, Modifier.fillMaxWidth().testTag("RESULT_BACK"))
            }
        }
    }
}

/**
 * The OWNER success mark: a circle that DRAWS itself (stroke arc sweep),
 * then the check stroke draws inside it, the mark glyph fading in with it.
 * Pure Compose Canvas — no dependency, no images.
 */
@Composable
private fun AnimatedVerdictMark(tone: Color, mark: String) {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(700, easing = FastOutSlowInEasing))
    }
    val p = progress.value
    Box(Modifier.size(124.dp).testTag("SCAN_SUCCESS_MARK"), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val strokeW = 10.dp.toPx()
            val stroke = Stroke(width = strokeW, cap = StrokeCap.Round)
            val inset = strokeW
            val arcSize = Size(size.width - 2 * inset, size.height - 2 * inset)
            val circleP = (p / 0.6f).coerceIn(0f, 1f)
            drawArc(
                color = tone,
                startAngle = -90f,
                sweepAngle = 360f * circleP,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = stroke,
            )
            val checkP = ((p - 0.6f) / 0.4f).coerceIn(0f, 1f)
            if (checkP > 0f) {
                val check = Path().apply {
                    moveTo(size.width * 0.28f, size.height * 0.53f)
                    lineTo(size.width * 0.44f, size.height * 0.69f)
                    lineTo(size.width * 0.74f, size.height * 0.33f)
                }
                val pm = PathMeasure()
                pm.setPath(check, false)
                val segment = Path()
                pm.getSegment(0f, pm.length * checkP, segment, true)
                drawPath(segment, tone, style = stroke)
            }
        }
        Text(
            mark,
            style = MaterialTheme.typography.displayLarge,
            color = tone,
            modifier = Modifier.graphicsLayer(alpha = ((p - 0.55f) / 0.45f).coerceIn(0f, 1f)),
        )
    }
}
