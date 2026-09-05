package com.ayrovi.worker.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The only palette/dimension owner for migrated Worker UI. Never use random screen tokens. */
object TerminalTokens {
    val background = Color(0xFF10161C)
    val surface = Color(0xFF19222B)
    val raised = Color(0xFF24323D)
    val text = Color(0xFFF0F4F6)
    val muted = Color(0xFFB4C2CC)
    val primary = Color(0xFFFFB066)
    val onPrimary = Color(0xFF23180E)
    val instruction = Color(0xFF8BD5EE)
    val success = Color(0xFF8FDBB5)
    val warning = Color(0xFFF4CB82)
    val error = Color(0xFFFFABA7)
    val border = Color(0xFF536675)

    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 24.dp
    val xl = 32.dp
    val radius = 4.dp
    val panelRadius = 8.dp
    val flat = 0.dp
    val raisedElevation = 2.dp
    val iconSmall = 20.dp
    val icon = 24.dp
    val stroke = 1.dp
    val touch = 56.dp
    val primaryTouch = 64.dp
    val scanPreview = 200.dp
    val reticle = 48.dp

    val typography = Typography(
        displaySmall = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 36.sp, lineHeight = 42.sp),
        headlineMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 32.sp),
        titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 28.sp),
        titleMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 18.sp, lineHeight = 24.sp),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 22.sp),
        labelMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 1.sp),
        labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    )
}

enum class TerminalTone { NEUTRAL, INSTRUCTION, SUCCESS, WARNING, ERROR }
fun TerminalTone.color(): Color = when (this) {
    TerminalTone.NEUTRAL -> TerminalTokens.muted
    TerminalTone.INSTRUCTION -> TerminalTokens.instruction
    TerminalTone.SUCCESS -> TerminalTokens.success
    TerminalTone.WARNING -> TerminalTokens.warning
    TerminalTone.ERROR -> TerminalTokens.error
}

@Composable
fun AyroviTerminalTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = TerminalTokens.primary, onPrimary = TerminalTokens.onPrimary,
            secondary = TerminalTokens.instruction, onSecondary = TerminalTokens.background,
            background = TerminalTokens.background, onBackground = TerminalTokens.text,
            surface = TerminalTokens.surface, onSurface = TerminalTokens.text,
            surfaceVariant = TerminalTokens.raised, onSurfaceVariant = TerminalTokens.muted,
            error = TerminalTokens.error, onError = TerminalTokens.background,
            outline = TerminalTokens.border,
        ),
        typography = TerminalTokens.typography,
        shapes = Shapes(
            small = RoundedCornerShape(TerminalTokens.radius),
            medium = RoundedCornerShape(TerminalTokens.panelRadius),
            large = RoundedCornerShape(TerminalTokens.panelRadius),
        ), content = content,
    )
}
