package com.ayrovi.worker.presentation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.ayrovi.worker.design.TerminalTokens

/**
 * MASTER ORDER §§8, 17, 20, 21 — capture surfaces of the worker terminal.
 *
 * The camera is a SECONDARY tool: the CT40 hardware trigger stays the primary
 * interaction, so a capture surface must never become a full-screen camera that
 * owns the screen. Each surface keeps exactly the region the engine reads
 * clear, and dims everything around it:
 *
 *  - [CaptureBand] : the OCR strip — a very short horizontal rectangle (about
 *    1–2 cm on a handheld), preview visible inside it only.
 *  - [QrCaptureArea] : the QR / barcode area — deliberately larger than the OCR
 *    strip, kept clear in the middle with the surrounding frame dimmed.
 *  - [ScanReadyIndicator] : the idle state — a small, quiet "ready" line that
 *    replaces any big scan box while the operator scans with the hardware
 *    trigger.
 */

/** Height of the OCR strip: ~1–2 cm on a CT40-class screen (order §17). */
private val OcrBandHeight: Dp = 64.dp
/** Height of the QR / barcode read area: bigger than OCR on purpose (order §20). */
private val QrAreaHeight: Dp = 200.dp
/** Dim applied outside the read region (order §17 "Dimmed"). */
private val MaskDim = Color.Black.copy(alpha = 0.62f)

/**
 * Vertical strip capture (OCR). The preview fills the surface; everything
 * except the central band is dimmed, so the operator's eye only has to frame
 * the code inside the strip.
 */
@Composable
internal fun CaptureBand(
    preview: @Composable (Modifier) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    bandHeight: Dp = OcrBandHeight,
) {
    Box(modifier.fillMaxWidth().height(bandHeight + 56.dp).testTag("CAPTURE_BAND")) {
        preview(Modifier.matchParentSize())
        Canvas(Modifier.matchParentSize()) {
            val band = size.height * 0.5f - bandHeight.toPx() / 2f
            // Dim above and below the band: outside the band is never read.
            drawRect(MaskDim, Offset.Zero, Size(size.width, band))
            drawRect(MaskDim, Offset(0f, band + bandHeight.toPx()), Size(size.width, size.height - band - bandHeight.toPx()))
            // Thin frame around the read band + a centre guide line.
            drawRect(
                color = Color.White.copy(alpha = 0.9f),
                topLeft = Offset(2f, band),
                size = Size(size.width - 4f, bandHeight.toPx()),
                style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f),
            )
            val midY = band + bandHeight.toPx() / 2f
            drawLine(Color.White.copy(alpha = 0.55f), Offset(10f, midY), Offset(size.width - 10f, midY), strokeWidth = 1.5f)
        }
        Text(
            label,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Black),
            color = Color.White,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 6.dp),
        )
    }
}

/**
 * QR / barcode read area. Larger than the OCR strip (order §20) and only the
 * surrounding frame is dimmed/softened: the read region itself stays crisp.
 */
@Composable
internal fun QrCaptureArea(
    preview: @Composable (Modifier) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    areaHeight: Dp = QrAreaHeight,
) {
    Box(modifier.fillMaxWidth().height(areaHeight).testTag("CAPTURE_QR_AREA")) {
        preview(Modifier.matchParentSize())
        Canvas(Modifier.matchParentSize()) {
            val side = minOf(size.height * 0.72f, size.width * 0.78f)
            val left = (size.width - side) / 2f
            val top = (size.height - side) / 2f
            // Dim everything outside the square read area.
            drawRect(MaskDim, Offset.Zero, Size(size.width, top))
            drawRect(MaskDim, Offset(0f, top + side), Size(size.width, size.height - top - side))
            drawRect(MaskDim, Offset(0f, top), Size(left, side))
            drawRect(MaskDim, Offset(left + side, top), Size(size.width - left - side, side))
            val stroke = 4f
            val arm = side * 0.22f
            val c = Color.White.copy(alpha = 0.95f)
            // Corner brackets: shows the operator where the QR must sit.
            listOf(
                Triple(Offset(left, top), Offset(left + arm, top), Offset(left, top + arm)),
                Triple(Offset(left + side, top), Offset(left + side - arm, top), Offset(left + side, top + arm)),
                Triple(Offset(left, top + side), Offset(left + arm, top + side), Offset(left, top + side - arm)),
                Triple(Offset(left + side, top + side), Offset(left + side - arm, top + side), Offset(left + side, top + side - arm)),
            ).forEach { (corner, h, v) ->
                drawLine(c, corner, h, strokeWidth = stroke)
                drawLine(c, corner, v, strokeWidth = stroke)
            }
        }
        Text(
            label,
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Black),
            color = Color.White,
            modifier = Modifier.align(Alignment.TopCenter).padding(top = 6.dp),
        )
    }
}

/**
 * Idle capture state (order §8/§23): a small quiet indicator instead of a big
 * scan box. The hardware trigger is the primary interaction, so the screen only
 * has to say that the terminal is armed and ready.
 */
@Composable
internal fun ScanReadyIndicator(
    text: String,
    modifier: Modifier = Modifier,
    tone: Color = TerminalTokens.instruction,
) {
    Row(
        modifier.fillMaxWidth().testTag("SCAN_READY")
            .background(TerminalTokens.surface, MaterialTheme.shapes.small)
            .border(TerminalTokens.stroke, TerminalTokens.border, MaterialTheme.shapes.small)
            .padding(horizontal = TerminalTokens.sm, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm),
    ) {
        Box(Modifier.size(10.dp).background(tone, CircleShape))
        Text(
            text,
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
            color = tone,
            modifier = Modifier.weight(1f),
        )
        Text(
            "TRIGGER / SCAN",
            style = MaterialTheme.typography.labelSmall,
            color = TerminalTokens.muted,
        )
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
