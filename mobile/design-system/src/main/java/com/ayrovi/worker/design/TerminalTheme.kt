package com.ayrovi.worker.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class TerminalThemeMode { WHITE, BLACK, INDUSTRIAL;
    fun next() = if (this == WHITE) BLACK else WHITE
}

/** One semantic palette per contrast mode. No screen-specific colors or business dependencies. */
@Immutable
data class TerminalPalette(
    val background: Color, val surface: Color, val raised: Color,
    val text: Color, val muted: Color, val primary: Color, val onPrimary: Color,
    val instruction: Color, val success: Color, val warning: Color, val error: Color,
    val onError: Color, val border: Color,
) {
    companion object {
        val White = TerminalPalette(
            background = Color(0xFFFFFFFF), surface = Color(0xFFFFFFFF), raised = Color(0xFFF1F3F5),
            text = Color(0xFF111111), muted = Color(0xFF42484F),
            primary = Color(0xFF111111), onPrimary = Color(0xFFFFFFFF),
            instruction = Color(0xFF00558C), success = Color(0xFF096640),
            warning = Color(0xFF7A4C00), error = Color(0xFFB42318),
            onError = Color(0xFFFFFFFF), border = Color(0xFF858C93),
        )
        val Black = TerminalPalette(
            background = Color(0xFF000000), surface = Color(0xFF101010), raised = Color(0xFF202020),
            text = Color(0xFFFFFFFF), muted = Color(0xFFC5C8CC),
            primary = Color(0xFFFFFFFF), onPrimary = Color(0xFF000000),
            instruction = Color(0xFF8DD5FF), success = Color(0xFF8FE0B3),
            warning = Color(0xFFFFD080), error = Color(0xFFFFADA5),
            onError = Color(0xFF230704), border = Color(0xFF767B80),
        )
        val Industrial = TerminalPalette(
            background = Color(0xFF0E1419), surface = Color(0xFF18232D), raised = Color(0xFF1D2A35),
            text = Color(0xFFF4F7FA), muted = Color(0xFFB7C2CC), primary = Color(0xFFFFB066), onPrimary = Color(0xFF23180E),
            instruction = Color(0xFF8BD7F5), success = Color(0xFF38D17A), warning = Color(0xFFF2C46D),
            error = Color(0xFFFF5252), onError = Color(0xFF190505), border = Color(0xFF536575),
        )
        fun forMode(mode: TerminalThemeMode) = when (mode) {
            TerminalThemeMode.WHITE -> White
            TerminalThemeMode.BLACK -> Black
            TerminalThemeMode.INDUSTRIAL -> Industrial
        }
    }
}

private val LocalTerminalPalette = staticCompositionLocalOf { TerminalPalette.White }
val LocalTerminalThemeMode = staticCompositionLocalOf { TerminalThemeMode.WHITE }
internal val LocalTerminalThemeToggle = staticCompositionLocalOf<(() -> Unit)?> { null }

/** The only dimension/type owner. Palette getters react to the theme without recreating tasks. */
object TerminalTokens {
    val background: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.background
    val surface: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.surface
    val raised: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.raised
    val text: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.text
    val muted: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.muted
    val primary: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.primary
    val onPrimary: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.onPrimary
    val instruction: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.instruction
    val success: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.success
    val warning: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.warning
    val error: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.error
    val onError: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.onError
    val border: Color @Composable @ReadOnlyComposable get() = LocalTerminalPalette.current.border

    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 24.dp
    val xl = 32.dp
    val radius = 4.dp
    val panelRadius = 4.dp
    val flat = 0.dp
    val raisedElevation = 2.dp
    val iconSmall = 20.dp
    val icon = 24.dp
    val workflowIcon = 40.dp
    val stateIcon = 72.dp
    val deviceVisual = 152.dp
    val compactDeviceVisual = 96.dp
    val tileHeight = 112.dp
    val stroke = 1.dp
    val touch = 56.dp
    val primaryTouch = 64.dp
    val headerActionWidth = 72.dp
    val scanPreview = 180.dp
    val reticle = 32.dp

    val typography = Typography(
        displaySmall = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 32.sp, lineHeight = 38.sp),
        headlineMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 28.sp),
        titleLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 26.sp),
        titleMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 18.sp, lineHeight = 24.sp),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        labelLarge = TextStyle(fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 20.sp),
        labelMedium = TextStyle(fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.5.sp),
        labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    )
}

enum class TerminalTone { NEUTRAL, INSTRUCTION, SUCCESS, WARNING, ERROR }
@Composable @ReadOnlyComposable
fun TerminalTone.color(): Color = when (this) {
    TerminalTone.NEUTRAL -> TerminalTokens.muted
    TerminalTone.INSTRUCTION -> TerminalTokens.instruction
    TerminalTone.SUCCESS -> TerminalTokens.success
    TerminalTone.WARNING -> TerminalTokens.warning
    TerminalTone.ERROR -> TerminalTokens.error
}

@Composable
fun AyroviTerminalTheme(
    mode: TerminalThemeMode = TerminalThemeMode.WHITE,
    onToggleTheme: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val palette = TerminalPalette.forMode(mode)
    val scheme = if (mode == TerminalThemeMode.WHITE) lightColorScheme() else darkColorScheme()
    CompositionLocalProvider(LocalTerminalPalette provides palette, LocalTerminalThemeMode provides mode,
        LocalTerminalThemeToggle provides onToggleTheme) {
        MaterialTheme(
            colorScheme = scheme.copy(
                primary = palette.primary, onPrimary = palette.onPrimary,
                secondary = palette.instruction, onSecondary = palette.background,
                background = palette.background, onBackground = palette.text,
                surface = palette.surface, onSurface = palette.text,
                surfaceVariant = palette.raised, onSurfaceVariant = palette.muted,
                error = palette.error, onError = palette.onError, outline = palette.border,
                surfaceContainer = palette.surface, surfaceContainerHigh = palette.raised,
                surfaceContainerHighest = palette.raised, surfaceContainerLow = palette.surface,
                surfaceContainerLowest = palette.background,
            ),
            typography = TerminalTokens.typography,
            shapes = Shapes(small = RoundedCornerShape(TerminalTokens.radius),
                medium = RoundedCornerShape(TerminalTokens.panelRadius), large = RoundedCornerShape(TerminalTokens.panelRadius)),
            content = content,
        )
    }
}
