package com.ayrovi.worker.presentation.ct40

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.TerminalPhase

/** Small native schematic: rugged bumpers, imager window and side triggers; no downloaded photo/logo. */
@Composable
fun CT40DeviceVisual(phase: TerminalPhase, modifier: Modifier = Modifier) {
    val ink = when (phase) {
        TerminalPhase.SUCCESS -> TerminalTokens.success
        TerminalPhase.ERROR -> TerminalTokens.error
        TerminalPhase.WARNING, TerminalPhase.OFFLINE -> TerminalTokens.warning
        else -> TerminalTokens.text
    }
    val body = TerminalTokens.surface
    val active = phase in setOf(TerminalPhase.SCANNING, TerminalPhase.VALIDATING)
    val line = if (active) {
        val transition = rememberInfiniteTransition(label = "scanner activity")
        val position by transition.animateFloat(0.25f, 0.65f, infiniteRepeatable(tween(850), RepeatMode.Reverse), label = "scan line")
        position
    } else .4f
    Box(modifier.aspectRatio(0.68f).testTag("CT40_DEVICE_VISUAL").semantics { contentDescription = "CT40 scanner · ${phase.name.lowercase()}" },
        contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width; val h = size.height; val stroke = w * .024f
            // Outline proportions deliberately evoke an industrial CT40 handheld, not a generic phone.
            drawRoundRect(body, Offset(w*.13f,h*.03f), Size(w*.74f,h*.94f), CornerRadius(w*.09f))
            drawRoundRect(ink, Offset(w*.13f,h*.03f), Size(w*.74f,h*.94f), CornerRadius(w*.09f), style = Stroke(stroke))
            drawRoundRect(ink, Offset(w*.25f,h*.055f), Size(w*.5f,h*.055f), CornerRadius(w*.025f), style = Stroke(stroke))
            drawRoundRect(ink, Offset(w*.205f,h*.18f), Size(w*.59f,h*.6f), CornerRadius(w*.025f), style = Stroke(stroke))
            // Dedicated physical side-trigger pads and bumper ribs.
            drawRoundRect(ink, Offset(w*.06f,h*.24f), Size(w*.07f,h*.2f), CornerRadius(w*.018f))
            drawRoundRect(ink, Offset(w*.87f,h*.24f), Size(w*.07f,h*.2f), CornerRadius(w*.018f))
            repeat(3) { i ->
                val y=h*(.55f+i*.065f)
                drawLine(ink, Offset(w*.105f,y), Offset(w*.17f,y), stroke)
                drawLine(ink, Offset(w*.83f,y), Offset(w*.895f,y), stroke)
            }
            repeat(3) { i -> drawCircle(ink, w*.019f, Offset(w*(.42f+i*.08f),h*.885f)) }
            if (active) drawLine(ink.copy(alpha = .7f), Offset(w*.26f,h*line), Offset(w*.74f,h*line), stroke)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            WorkerIcon(when (phase) {
                TerminalPhase.SUCCESS -> TerminalIcon.SUCCESS
                TerminalPhase.ERROR -> TerminalIcon.ERROR
                TerminalPhase.WARNING, TerminalPhase.OFFLINE -> TerminalIcon.WARNING
                else -> TerminalIcon.SCANNER
            }, null, Modifier.size(TerminalTokens.workflowIcon), ink)
            Text("CT40", style = MaterialTheme.typography.labelMedium, color = ink)
        }
    }
}
