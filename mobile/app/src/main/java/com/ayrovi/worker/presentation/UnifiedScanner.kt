package com.ayrovi.worker.presentation

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ayrovi.worker.design.PrimaryAction
import com.ayrovi.worker.design.SecondaryAction
import com.ayrovi.worker.design.TerminalIcon
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.design.WorkerIcon
import com.ayrovi.worker.scanner.ScannerCapture

/**
 * MASTER ORDER §§14–35 — ONE unified Scanner UX for the whole Worker app.
 *
 * The scanner screen is not a dashboard and not a tool list (§29): it shows
 * READY TO SCAN + the CT40 indication + ONE small side button. Camera / OCR /
 * manual entry live in a side drawer that opens only when the operator asks for
 * it (§17) and close themselves as soon as the read is done (§21).
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
) {
    Column(modifier.fillMaxWidth().testTag("SCANNER_PANEL"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text(title, style = MaterialTheme.typography.titleMedium, color = TerminalTokens.warning)
        subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted) }

        when {
            // A selected tool owns the panel only while it is used, but the
            // small side button stays available: the operator can jump straight
            // from a tool back to the CT40 hardware default (§18/§19) without
            // closing and re-opening the drawer.
            capture.manualOpen -> ToolRail(onOpenTools) { ManualScan(capture, enabled) }
            capture.cameraOpen -> ToolRail(onOpenTools) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    QrCaptureArea(preview = capture.preview, label = "QR / BARCODE")
                    Text(
                        "Frame the QR / barcode. The CT40 trigger stays the primary scanner.",
                        style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted,
                    )
                    SecondaryAction("CLOSE TOOL", capture.cancel, enabled)
                }
            }
            capture.ocrOpen -> ToolRail(onOpenTools) { OcrScan(capture, enabled) }
            else -> ReadyToScanPanel(capture, enabled, onOpenTools = onOpenTools)
        }

        extra?.invoke()
    }
}

/**
 * Default state (§15/§19/§29): READY TO SCAN, a small CT40 indication and the
 * single side-tools arrow. No big scan buttons — the operator uses the hardware
 * trigger of the terminal.
 *
 * If the terminal exposes no hardware scanner (emulator / plain phone), a small
 * TRIGGER line is shown instead of pretending a trigger exists: the software
 * trigger of the SAME scanner stack stays reachable without becoming the
 * default.
 */
@Composable
internal fun ReadyToScanPanel(capture: ScannerCapture, enabled: Boolean, onOpenTools: () -> Unit) {
    var showTrigger by remember { mutableStateOf(false) }
    Surface(
        Modifier.fillMaxWidth().testTag("READY_TO_SCAN"),
        color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
    ) {
        Box(Modifier.fillMaxWidth()) {
            Column(
                Modifier.fillMaxWidth().padding(TerminalTokens.md).padding(end = ToolsRail),
                verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "READY TO SCAN",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Black),
                    color = TerminalTokens.instruction,
                )
                Ct40Glyph(available = capture.hardwareAvailable)
                Text(
                    if (capture.hardwareAvailable) "Hardware Scanner" else "No hardware scanner detected",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (capture.hardwareAvailable) TerminalTokens.muted else TerminalTokens.warning,
                )
                Text(
                    if (capture.hardwareAvailable) "Use the CT40 side trigger — no screen button needed."
                    else "Use the trigger line below, or open the tools to scan another way.",
                    style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted,
                )
                if (!capture.hardwareAvailable) {
                    if (showTrigger) {
                        PrimaryAction("TRIGGER SCAN", capture.softwareScan, enabled, Modifier.testTag("SOFTWARE_TRIGGER"))
                    } else {
                        SecondaryAction("SHOW TRIGGER", { showTrigger = true }, enabled, Modifier.testTag("SHOW_TRIGGER"))
                    }
                }
            }
            ScanToolsArrow(Modifier.align(Alignment.CenterEnd), onOpenTools)
        }
    }
}

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

/**
 * Width of the reserved side rail. It is the gloved-touch token (56 dp), so the
 * small button is comfortable to hit one-handed and the rail it lives in never
 * overlaps a control (§31).
 */
private val ToolsRail = 56.dp

/**
 * A tool is open: the tool content gets a reserved right rail and the SAME side
 * button is drawn in it, so the drawer is always one small tap away without
 * covering the tool the operator is currently using (§16/§18/§31).
 */
@Composable
private fun ToolRail(onOpenTools: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().padding(end = ToolsRail)) { content() }
        ScanToolsArrow(Modifier.align(Alignment.CenterEnd), onOpenTools)
    }
}

/**
 * The single, small, semi-transparent side button (§16). The strip stays small
 * (34 dp) but the touch target is finger-sized (48 × 72 dp) so it is easy to hit
 * with gloves on while the CT40 is held one-handed (§31).
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
 * Side drawer (§17/§18/§20): QR / BARCODE, OCR, MANUEL, CT40, FERMER.
 * Icon + short label only. Picking a tool closes the drawer immediately and
 * opens that tool; CT40 returns to the hardware-scanner default.
 */
@Composable
internal fun ScanToolsDrawer(capture: ScannerCapture, enabled: Boolean, onClose: () -> Unit) {
    Box(Modifier.fillMaxSize().testTag("SCAN_TOOLS_DRAWER")) {
        // Scrim: tapping outside closes without changing the current mode.
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.45f)).clickable(onClick = onClose),
        )
        Surface(
            Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(210.dp),
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
                DrawerItem("CT40", TerminalIcon.CHECK, "TOOL_CT40", enabled) {
                    onClose(); capture.cancel() // back to the hardware scanner default
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
                    WorkerIcon(if (ok) TerminalIcon.SUCCESS else TerminalIcon.ERROR, null, Modifier.size(30.dp), tone)
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
