package com.ayrovi.worker.presentation

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
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
import com.ayrovi.worker.scanner.ScannerCapture

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
internal fun CameraToolOverlay(capture: ScannerCapture, enabled: Boolean) {
    val ocr = capture.ocrCameraOpen
    Box(
        Modifier.fillMaxSize()
            .background(if (ocr) Color.Black else Color.Black.copy(alpha = 0.92f))
            .testTag(if (ocr) "OCR_SCAN" else "CAPTURE_QR_AREA"),
    ) {
        if (ocr) {
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
        } else {
            QrTakeoverSquare(capture.preview)
        }
        SecondaryAction(
            "BACK", capture.cancel, enabled,
            Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                .padding(horizontal = TerminalTokens.lg, vertical = TerminalTokens.lg)
                .testTag("TOOL_BACK"),
        )
    }
}

/**
 * OCR aperture: a bounded horizontal rectangle, centered, black on every
 * side — the ONLY camera opening (the live preview is clipped to it).
 * Deliberately smaller than the screen: a full-width strip reads as a
 * screen-sized camera, while this is a viewfinder window for one SKU line.
 */
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

/** QR / barcode square: about half the screen, centered, preview clipped to it. */
@Composable
private fun QrTakeoverSquare(preview: @Composable (Modifier) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val side = (maxWidth * 0.86f).coerceAtMost(maxHeight * 0.52f)
        Box(Modifier.align(Alignment.Center).size(side)) {
            preview(Modifier.matchParentSize())
            Canvas(Modifier.matchParentSize()) {
                val s = size.width
                val arm = s * 0.20f
                val c = Color.White.copy(alpha = 0.95f)
                val stroke = 5f
                // Corner brackets: shows the operator where the QR must sit.
                drawLine(c, Offset(0f, 0f), Offset(arm, 0f), strokeWidth = stroke)
                drawLine(c, Offset(0f, 0f), Offset(0f, arm), strokeWidth = stroke)
                drawLine(c, Offset(s, 0f), Offset(s - arm, 0f), strokeWidth = stroke)
                drawLine(c, Offset(s, 0f), Offset(s, arm), strokeWidth = stroke)
                drawLine(c, Offset(0f, s), Offset(arm, s), strokeWidth = stroke)
                drawLine(c, Offset(0f, s), Offset(0f, s - arm), strokeWidth = stroke)
                drawLine(c, Offset(s, s), Offset(s - arm, s), strokeWidth = stroke)
                drawLine(c, Offset(s, s), Offset(s, s - arm), strokeWidth = stroke)
            }
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
            WorkerIcon(icon, null, Modifier.size(22.dp), if (enabled) TerminalTokens.instruction else TerminalTokens.muted)
            Text(label, style = MaterialTheme.typography.labelLarge,
                color = if (enabled) TerminalTokens.text else TerminalTokens.muted)
        }
    }
}

/**
 * Scan RESULT (§27/§28): stays in the foreground with the rest of the interface
 * dimmed, and is NEVER auto-dismissed — it remains until the operator presses
 * BACK or triggers a new scan (which replaces it).
 */
@Composable
internal fun ScanResultOverlay(
    ok: Boolean,
    title: String,
    detail: String,
    lines: List<String> = emptyList(),
    onBack: () -> Unit,
) {
    val tone = if (ok) TerminalTokens.success else TerminalTokens.error
    Box(Modifier.fillMaxSize().testTag("SCAN_RESULT").background(Color.Black.copy(alpha = 0.62f))) {
        Surface(
            Modifier.align(Alignment.Center).fillMaxWidth().padding(TerminalTokens.md),
            color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
            border = BorderStroke(3.dp, tone),
        ) {
            Column(Modifier.fillMaxWidth().padding(TerminalTokens.md), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
                horizontalAlignment = Alignment.CenterHorizontally) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                    WorkerIcon(if (ok) TerminalIcon.SUCCESS else TerminalIcon.ERROR, null, Modifier.size(38.dp), tone)
                    Text(
                        if (ok) "✓ SUCCESS" else "✕ ERROR",
                        style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Black),
                        color = tone,
                    )
                }
                Text(title, style = MaterialTheme.typography.titleMedium, color = TerminalTokens.text)
                if (detail.isNotBlank()) {
                    Text(detail, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                }
                lines.forEach { line ->
                    Text(line, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        color = TerminalTokens.text)
                }
                Spacer(Modifier.height(2.dp))
                PrimaryAction("BACK", onBack, true, Modifier.testTag("RESULT_BACK"))
            }
        }
    }
}
