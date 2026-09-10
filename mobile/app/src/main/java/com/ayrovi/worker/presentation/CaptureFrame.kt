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
 * interaction. When a camera tool IS used it takes over the whole screen
 * (CameraToolOverlay in UnifiedScanner.kt): the background is fogged and only
 * the capture region + BACK stay visible.
 *
 *  - [ScanReadyIndicator] : the idle state — a small, quiet "ready" line that
 *    replaces any big scan box while the operator scans with the hardware
 *    trigger.
 */

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
