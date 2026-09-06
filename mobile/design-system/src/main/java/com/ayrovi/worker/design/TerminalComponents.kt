@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.ayrovi.worker.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign

@Composable
fun TerminalShell(
    header: @Composable () -> Unit,
    footer: @Composable () -> Unit,
    scrollKey: Any? = null,
    toolbar: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val scroll = rememberScrollState()
    LaunchedEffect(scrollKey) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize().background(TerminalTokens.background).safeDrawingPadding().imePadding()) {
        header()
        toolbar()
        HorizontalDivider(color = TerminalTokens.border)
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).padding(TerminalTokens.sm),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm), content = content)
        footer()
    }
}

@Composable
fun TerminalHeader(
    operation: String, worker: String, station: String?, connection: String,
    onBack: (() -> Unit)? = null, backEnabled: Boolean = true,
) {
    val toggleTheme = LocalTerminalThemeToggle.current
    val mode = LocalTerminalThemeMode.current
    Surface(color = TerminalTokens.background) {
        Column(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm, vertical = TerminalTokens.xs),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md),
                verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
                Text("AYROVI / WORKER", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.text)
                ConnectionStatus(connection)
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                if (onBack != null) HeaderAction("‹", "Back to work queue", onBack, backEnabled)
                Text(operation, style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f).semantics { heading() })
                if (toggleTheme != null) HeaderAction(mode.next().name,
                    "Switch to ${mode.next().name.lowercase()} theme", toggleTheme)
            }
            Text(listOfNotNull(station, worker).joinToString(" · "), style = MaterialTheme.typography.bodyMedium,
                color = TerminalTokens.muted)
        }
    }
}

@Composable
private fun HeaderAction(label: String, description: String, onClick: () -> Unit, enabled: Boolean = true) {
    OutlinedButton(onClick = onClick, enabled = enabled,
        modifier = Modifier.width(TerminalTokens.headerActionWidth).heightIn(min = TerminalTokens.touch)
            .semantics { contentDescription = description },
        shape = MaterialTheme.shapes.small, border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = TerminalTokens.text),
        contentPadding = PaddingValues(TerminalTokens.xs)) {
        Text(label, style = if (label == "‹") MaterialTheme.typography.headlineMedium else MaterialTheme.typography.labelLarge)
    }
}

/** Generic, state-driven segmented control. It knows no warehouse rule or API. */
@Composable
fun TerminalModeSelector(
    first: String, second: String, firstSelected: Boolean, enabled: Boolean,
    onFirst: () -> Unit, onSecond: () -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm, vertical = TerminalTokens.xs),
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        listOf(Triple(first, firstSelected, onFirst), Triple(second, !firstSelected, onSecond)).forEach { (label, chosen, action) ->
            val modifier = Modifier.weight(1f).heightIn(min = TerminalTokens.touch)
                .semantics { selected = chosen; role = Role.Tab }
            if (chosen) Button(onClick = action, enabled = enabled, modifier = modifier,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalTokens.primary, contentColor = TerminalTokens.onPrimary),
                contentPadding = PaddingValues(TerminalTokens.xs)) {
                Text("✓ $label", style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
            } else OutlinedButton(onClick = action, enabled = enabled, modifier = modifier,
                shape = MaterialTheme.shapes.small, border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = TerminalTokens.text),
                contentPadding = PaddingValues(TerminalTokens.xs)) {
                Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
fun TerminalFooter(instruction: String, actions: @Composable ColumnScope.() -> Unit) {
    Surface(color = TerminalTokens.surface, tonalElevation = TerminalTokens.flat) {
        Column(Modifier.fillMaxWidth().padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            Text(instruction, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
            actions()
        }
    }
}

@Composable
fun TerminalPanel(title: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border)) {
        Column(Modifier.padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            if (title != null) Text(title, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
            content()
        }
    }
}

@Composable fun TaskHeader(number: String, status: String, detail: String? = null) {
    TerminalPanel {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md),
            verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            TaskNumber(number)
            TaskStatus(status)
        }
        if (detail != null) Text(detail, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
    }
}
@Composable fun TaskNumber(number: String) = Text(number, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace))
@Composable fun TaskInstruction(text: String, detail: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text(text, style = MaterialTheme.typography.headlineMedium, color = TerminalTokens.instruction, modifier = Modifier.semantics { heading() })
        if (detail != null) Text(detail, style = MaterialTheme.typography.bodyLarge)
    }
}
@Composable fun TaskStatus(text: String, tone: TerminalTone = TerminalTone.NEUTRAL) = StatusBadge(text, tone)

@Composable
fun LocationBlock(code: String, hierarchy: List<Pair<String, String>> = emptyList(), label: String = "LOCATION") {
    TerminalPanel(label) { LocationCode(code); if (hierarchy.isNotEmpty()) LocationHierarchy(hierarchy) }
}
@Composable fun LocationCode(code: String) = Text(code, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace))
@Composable fun LocationHierarchy(values: List<Pair<String, String>>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(TerminalTokens.lg), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
        values.forEach { (label, value) ->
            Column { Text(label, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted); LocationCode(value) }
        }
    }
}
@Composable fun ProductBlock(name: String?, sku: String, detail: String? = null) {
    TerminalPanel("PRODUCT") { ProductIdentity(name ?: "Product name not supplied"); SKUBlock(sku); if (detail != null) Text(detail, style = MaterialTheme.typography.bodyMedium) }
}
@Composable fun ProductIdentity(name: String) = Text(name, style = MaterialTheme.typography.titleLarge)
@Composable fun SKUBlock(sku: String) { Text("SKU", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted); BarcodeDisplay(sku) }
@Composable fun BarcodeDisplay(value: String) {
    SelectionContainer { Text(value, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Monospace)) }
}

@Composable
fun ScanZone(label: String, enabled: Boolean, controls: @Composable ColumnScope.() -> Unit) {
    val scanColor = if (enabled) TerminalTokens.instruction else TerminalTokens.muted
    Surface(Modifier.fillMaxWidth(), color = TerminalTokens.surface, shape = MaterialTheme.shapes.medium,
        border = BorderStroke(TerminalTokens.stroke, if (enabled) TerminalTokens.instruction else TerminalTokens.border)) {
        Column(Modifier.padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
                Canvas(Modifier.size(TerminalTokens.reticle)) {
                    val stroke = TerminalTokens.stroke.toPx() * 2
                    val arm = size.width / 3
                    val c = scanColor
                    for ((x, y) in listOf(0f to 0f, size.width to 0f, 0f to size.height, size.width to size.height)) {
                        drawLine(c, Offset(x, y), Offset(if (x == 0f) arm else x - arm, y), stroke)
                        drawLine(c, Offset(x, y), Offset(x, if (y == 0f) arm else y - arm), stroke)
                    }
                }
                Text(label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            }
            controls()
        }
    }
}
@Composable fun ScanStatus(text: String, tone: TerminalTone = TerminalTone.INSTRUCTION) = StatusBadge(text, tone)
@Composable fun ScanResult(title: String, detail: String, tone: TerminalTone) = OperationalState(title, detail, tone)

@Composable fun QuantityDisplay(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
        Text(value, style = MaterialTheme.typography.displaySmall)
    }
}
@Composable fun QuantityInput(value: String, onValueChange: (String) -> Unit, enabled: Boolean = true, error: String? = null) =
    NumericInput("RECEIVED QUANTITY", value, onValueChange, enabled, error)
@Composable fun NumericInput(label: String, value: String, onValueChange: (String) -> Unit, enabled: Boolean = true, error: String? = null) {
    TerminalTextInput(label, value, onValueChange, enabled = enabled, keyboardType = KeyboardType.Number, error = error)
}
@Composable fun QuantityStepper(value: String, onMinus: () -> Unit, onPlus: () -> Unit, minusEnabled: Boolean, plusEnabled: Boolean) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
        SecondaryAction("−", onMinus, minusEnabled, Modifier.widthIn(min = TerminalTokens.touch))
        Text(value, style = MaterialTheme.typography.displaySmall, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
        SecondaryAction("+", onPlus, plusEnabled, Modifier.widthIn(min = TerminalTokens.touch))
    }
}
@Composable fun ProgressIndicator(current: Int, total: Int, label: String) {
    Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text("$label · $current / $total", style = MaterialTheme.typography.bodyMedium)
        LinearProgressIndicator(progress = { if (total > 0) (current.toFloat() / total).coerceIn(0f, 1f) else 0f },
            modifier = Modifier.fillMaxWidth(), color = TerminalTokens.instruction, trackColor = TerminalTokens.raised)
    }
}
@Composable fun StepIndicator(current: Int, total: Int, label: String) = Text("STEP $current / $total · $label", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)

@Composable
fun TerminalNotice(title: String, detail: String, tone: TerminalTone) {
    Surface(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
        color = TerminalTokens.raised, shape = MaterialTheme.shapes.small) {
        Column(Modifier.padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            StatusBadge(title, tone)
            Text(detail, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable fun SuccessState(title: String, detail: String) = OperationalState(title, detail, TerminalTone.SUCCESS)
@Composable fun WarningState(title: String, detail: String) = OperationalState(title, detail, TerminalTone.WARNING)
@Composable fun ExceptionState(title: String, detail: String) = OperationalState(title, detail, TerminalTone.WARNING)
@Composable fun ErrorState(title: String, detail: String, expected: String? = null, scanned: String? = null) {
    OperationalState(title, detail, TerminalTone.ERROR, expected, scanned)
}
@Composable fun LoadingState(label: String = "Checking warehouse server…") {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
        CircularProgressIndicator(Modifier.size(TerminalTokens.icon), color = TerminalTokens.instruction, strokeWidth = TerminalTokens.stroke * 2)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}
@Composable fun EmptyState(title: String, detail: String) = OperationalState(title, detail, TerminalTone.NEUTRAL)

@Composable
private fun OperationalState(title: String, detail: String, tone: TerminalTone, expected: String? = null, scanned: String? = null) {
    Surface(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, color = TerminalTokens.surface,
        shape = MaterialTheme.shapes.small, border = BorderStroke(TerminalTokens.stroke, tone.color())) {
        Column(Modifier.padding(TerminalTokens.sm), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            Text("${symbol(tone)}  $title", style = MaterialTheme.typography.titleMedium, color = tone.color())
            Text(detail, style = MaterialTheme.typography.bodyLarge)
            if (expected != null) { Text("EXPECTED", style = MaterialTheme.typography.labelMedium); BarcodeDisplay(expected) }
            if (scanned != null) { Text("SCANNED", style = MaterialTheme.typography.labelMedium); BarcodeDisplay(scanned) }
        }
    }
}
private fun symbol(tone: TerminalTone) = when (tone) {
    TerminalTone.SUCCESS -> "✓"
    TerminalTone.WARNING -> "!"
    TerminalTone.ERROR -> "×"
    TerminalTone.INSTRUCTION -> "+"
    TerminalTone.NEUTRAL -> "—"
}
@Composable fun StatusBadge(text: String, tone: TerminalTone = TerminalTone.NEUTRAL) {
    Text("${symbol(tone)} $text", style = MaterialTheme.typography.labelMedium, color = tone.color())
}
@Composable fun ConnectionStatus(state: String) = StatusBadge(state.replace('_', ' '), when (state) {
    "ONLINE" -> TerminalTone.SUCCESS
    "SYNCING", "CHECKING" -> TerminalTone.INSTRUCTION
    "OFFLINE", "SYNC_ERROR", "AUTH_ERROR" -> TerminalTone.ERROR
    else -> TerminalTone.NEUTRAL
})
@Composable fun SyncStatus(label: String) = StatusBadge(label, TerminalTone.INSTRUCTION)
@Composable fun OfflineStatus() = StatusBadge("OFFLINE · SERVER AUTHORIZATION REQUIRED", TerminalTone.WARNING)

@Composable fun PrimaryAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier, primary = true)
@Composable fun SecondaryAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier)
@Composable fun DangerAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier, danger = true)
@Composable fun ConfirmAction(label: String = "CONFIRM", onClick: () -> Unit, enabled: Boolean = true) = PrimaryAction(label, onClick, enabled)
@Composable fun RejectAction(onClick: () -> Unit, enabled: Boolean = true) = DangerAction("REJECT", onClick, enabled)
@Composable fun RetryAction(onClick: () -> Unit, enabled: Boolean = true, label: String = "RETRY") = SecondaryAction(label, onClick, enabled)
@Composable fun PauseAction(onClick: () -> Unit, enabled: Boolean = true) = SecondaryAction("PAUSE", onClick, enabled)

@Composable
private fun TerminalAction(label: String, onClick: () -> Unit, enabled: Boolean, modifier: Modifier, primary: Boolean = false, danger: Boolean = false) {
    val size = modifier.heightIn(min = if (primary) TerminalTokens.primaryTouch else TerminalTokens.touch)
    val text: @Composable RowScope.() -> Unit = { Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center) }
    if (primary || danger) Button(onClick, size, enabled,
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = if (danger) TerminalTokens.error else TerminalTokens.primary,
            contentColor = if (danger) TerminalTokens.onError else TerminalTokens.onPrimary),
        contentPadding = PaddingValues(TerminalTokens.md), content = text)
    else OutlinedButton(onClick, size, enabled, shape = MaterialTheme.shapes.small,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = TerminalTokens.text),
        contentPadding = PaddingValues(TerminalTokens.sm), content = text)
}

@Composable
fun TerminalTextInput(
    label: String, value: String, onValueChange: (String) -> Unit,
    enabled: Boolean = true, secret: Boolean = false, keyboardType: KeyboardType = KeyboardType.Text,
    error: String? = null, onSubmit: (() -> Unit)? = null, singleLine: Boolean = true,
    modifier: Modifier = Modifier.fillMaxWidth(),
) {
    OutlinedTextField(
        value = value, onValueChange = onValueChange, enabled = enabled, singleLine = singleLine,
        maxLines = if (singleLine) 1 else 4,
        label = { Text(label, style = MaterialTheme.typography.labelMedium) },
        textStyle = MaterialTheme.typography.bodyLarge,
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (secret && keyboardType == KeyboardType.Text) KeyboardType.Password else keyboardType,
            autoCorrectEnabled = false, imeAction = if (onSubmit != null) ImeAction.Done else ImeAction.Default),
        keyboardActions = KeyboardActions(onDone = { if (enabled) onSubmit?.invoke() }),
        isError = error != null, supportingText = error?.let { { Text(it) } },
        modifier = modifier.heightIn(min = TerminalTokens.touch),
        shape = MaterialTheme.shapes.small,
    )
}

@Composable
fun ModalException(
    title: String, reason: String, onReason: (String) -> Unit,
    onDismiss: () -> Unit, onConfirm: () -> Unit, enabled: Boolean, confirmLabel: String = "REPORT", message: String? = null,
) {
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text(title, style = MaterialTheme.typography.titleLarge) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                if (message != null) ErrorState("OPERATION NEEDS ATTENTION", message)
                TerminalTextInput("ACTUAL REASON", reason, onReason, enabled = enabled, singleLine = false)
            }
        },
        confirmButton = { ConfirmAction(confirmLabel, onConfirm, enabled && reason.isNotBlank()) },
        dismissButton = { SecondaryAction("BACK", onDismiss) },
        shape = MaterialTheme.shapes.medium, containerColor = TerminalTokens.surface)
}
