@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.ayrovi.worker.design

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import kotlinx.coroutines.delay
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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

/** Compact identity header; device classification is provided, never detected by this component. */
@Composable
fun TerminalHeader(
    operation: String, worker: String, station: String?, connection: String,
    onBack: (() -> Unit)? = null, backEnabled: Boolean = true,
    industrial: Boolean = false, onSettings: (() -> Unit)? = null,
) {
    val toggle = LocalTerminalThemeToggle.current
    Surface(color = TerminalTokens.background, modifier = Modifier.testTag(if (industrial) "CT40_HEADER" else "PHONE_HEADER")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = TerminalTokens.sm, vertical = TerminalTokens.xxs)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                Text("AYROVI", style = MaterialTheme.typography.titleMedium)
                ConnectionStatus(connection)
                if (!industrial) Text(station ?: "NO STATION", style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.weight(1f), color = TerminalTokens.muted)
                else Spacer(Modifier.weight(1f))
                val settings = onSettings ?: toggle
                if (settings != null) TerminalIconAction(TerminalIcon.SETTINGS, "Worker and settings", settings)
            }
            Text(if (industrial) "$operation · ${station ?: "NO STATION"}" else worker,
                style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
        }
    }
}

@Composable
fun TerminalIconAction(icon: TerminalIcon, label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier) {
    IconButton(onClick = onClick, enabled = enabled,
        modifier = modifier.size(TerminalTokens.touch).semantics { contentDescription = label }) {
        WorkerIcon(icon, null, Modifier.size(TerminalTokens.icon), if (enabled) TerminalTokens.text else TerminalTokens.muted)
    }
}

/** Small icon tile, not a dashboard card. Count null means unknown/unavailable, NOT zero. */
@Composable
fun WorkflowTile(label: String, icon: TerminalIcon, count: Int?, available: Boolean, enabled: Boolean,
    onClick: () -> Unit, modifier: Modifier = Modifier) {
    var previous by remember { mutableStateOf(count) }
    var emphasize by remember { mutableStateOf(false) }
    LaunchedEffect(count) {
        emphasize = previous != null && count != null && count > (previous ?: 0)
        previous = count
        if (emphasize) { delay(350); emphasize = false }
    }
    val scale by animateFloatAsState(if (emphasize) 1.06f else 1f, tween(180), label = "work count update")
    OutlinedButton(onClick, modifier.heightIn(min = TerminalTokens.tileHeight), enabled && available,
        shape = MaterialTheme.shapes.small, border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        contentPadding = PaddingValues(TerminalTokens.xs), colors = ButtonDefaults.outlinedButtonColors(contentColor = TerminalTokens.text)) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            Box {
                WorkerIcon(icon, null, Modifier.size(TerminalTokens.workflowIcon), if (available) TerminalTokens.text else TerminalTokens.muted)
                if (count != null && count > 0) Badge(Modifier.align(Alignment.TopEnd).graphicsLayer { scaleX = scale; scaleY = scale },
                    containerColor = TerminalTokens.instruction, contentColor = TerminalTokens.background) {
                    Text(count.toString(), modifier = Modifier.semantics { contentDescription = "$count waiting" })
                }
            }
            Text(label, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center)
            if (!available) Text("NOT AVAILABLE", style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center)
        }
    }
}

/** Generic, state-driven segmented control. It knows no warehouse rule or API. */
@Composable
fun TerminalModeSelector(
    first: String, second: String, firstSelected: Boolean, enabled: Boolean,
    onFirst: () -> Unit, onSecond: () -> Unit, padded: Boolean = true,
) {
    Row(Modifier.fillMaxWidth().testTag("MODE_SELECTOR").then(if (padded) Modifier.padding(horizontal = TerminalTokens.sm, vertical = TerminalTokens.xs) else Modifier),
        horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        listOf(Triple(first, firstSelected, onFirst), Triple(second, !firstSelected, onSecond)).forEach { (label, chosen, action) ->
            val modifier = Modifier.weight(1f).heightIn(min = TerminalTokens.touch)
                .semantics { selected = chosen; role = Role.Tab }
            if (chosen) Button(onClick = action, enabled = enabled, modifier = modifier,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = TerminalTokens.primary, contentColor = TerminalTokens.onPrimary),
                contentPadding = PaddingValues(TerminalTokens.xs)) {
                WorkerIcon(TerminalIcon.CHECK, null, Modifier.size(TerminalTokens.iconSmall), TerminalTokens.onPrimary)
                Spacer(Modifier.width(TerminalTokens.xxs))
                Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
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
            if (instruction.isNotBlank()) Text(instruction, style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
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
    TerminalPanel("PRODUCT") { ProductIdentity(name ?: "Product"); SKUBlock(sku); if (detail != null) Text(detail, style = MaterialTheme.typography.bodyMedium) }
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
@Composable fun LoadingState(label: String = "Please wait…") {
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
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                WorkerIcon(tone.icon(), null, Modifier.size(TerminalTokens.icon), tone.color())
                Text(title, style = MaterialTheme.typography.titleMedium, color = tone.color())
            }
            Text(detail, style = MaterialTheme.typography.bodyLarge)
            if (expected != null) { Text("EXPECTED", style = MaterialTheme.typography.labelMedium); BarcodeDisplay(expected) }
            if (scanned != null) { Text("SCANNED", style = MaterialTheme.typography.labelMedium); BarcodeDisplay(scanned) }
        }
    }
}
private fun TerminalTone.icon() = when (this) {
    TerminalTone.SUCCESS -> TerminalIcon.SUCCESS
    TerminalTone.WARNING -> TerminalIcon.WARNING
    TerminalTone.ERROR -> TerminalIcon.ERROR
    TerminalTone.INSTRUCTION -> TerminalIcon.SCANNER
    TerminalTone.NEUTRAL -> TerminalIcon.QUEUE
}
@Composable fun StatusBadge(text: String, tone: TerminalTone = TerminalTone.NEUTRAL) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
        WorkerIcon(tone.icon(), null, Modifier.size(TerminalTokens.iconSmall), tone.color())
        Text(text, style = MaterialTheme.typography.labelMedium, color = tone.color())
    }
}
@Composable fun ConnectionStatus(state: String) {
    val label = when (state) {
        "ONLINE" -> "ONLINE"
        "SYNCING", "CHECKING" -> "SYNCING"
        "AUTH_ERROR" -> "SIGN IN"
        else -> "OFFLINE"
    }
    val color = when (label) { "ONLINE" -> TerminalTokens.success; "SYNCING" -> TerminalTokens.warning; else -> TerminalTokens.error }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
        if (label == "SYNCING") CircularProgressIndicator(Modifier.size(TerminalTokens.iconSmall), color = color, strokeWidth = TerminalTokens.stroke * 2)
        else WorkerIcon(if (label == "ONLINE") TerminalIcon.ONLINE else TerminalIcon.OFFLINE, null, Modifier.size(TerminalTokens.iconSmall), color)
        Text(label, style = MaterialTheme.typography.labelMedium, color = color)
    }
}
@Composable fun SyncStatus(label: String) = StatusBadge(label, TerminalTone.INSTRUCTION)
@Composable fun OfflineStatus() = StatusBadge("OFFLINE · RECEIVING STOPPED", TerminalTone.WARNING)

@Composable fun PrimaryAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier, primary = true)
@Composable fun SecondaryAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier)
@Composable fun DangerAction(label: String, onClick: () -> Unit, enabled: Boolean = true, modifier: Modifier = Modifier.fillMaxWidth()) = TerminalAction(label, onClick, enabled, modifier, danger = true)
@Composable fun ConfirmAction(label: String = "CONFIRM", onClick: () -> Unit, enabled: Boolean = true) = PrimaryAction(label, onClick, enabled)
@Composable fun RejectAction(onClick: () -> Unit, enabled: Boolean = true) = DangerAction("REJECT", onClick, enabled)
@Composable fun RetryAction(onClick: () -> Unit, enabled: Boolean = true, label: String = "RETRY") = SecondaryAction(label, onClick, enabled)
@Composable fun PauseAction(onClick: () -> Unit, enabled: Boolean = true) = SecondaryAction("PAUSE", onClick, enabled)

/**
 * Zebra-class industrial action: a flat solid slab with sharp 4dp corners, a
 * bold tracked label and a glove-sized height. Primary = brand fill, danger =
 * signal red, secondary = raised slab with a bright edge — NEVER a ghost
 * outline (unreadable with gloves and sunlight on the line).
 */
@Composable
private fun TerminalAction(label: String, onClick: () -> Unit, enabled: Boolean, modifier: Modifier, primary: Boolean = false, danger: Boolean = false) {
    val size = modifier.heightIn(min = if (primary) TerminalTokens.primaryTouch else TerminalTokens.touch)
    val style = MaterialTheme.typography.labelLarge.copy(letterSpacing = 0.75.sp)
    val text: @Composable RowScope.() -> Unit = { Text(label, style = style, textAlign = TextAlign.Center, maxLines = 2) }
    val flat = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp,
        focusedElevation = 0.dp, hoveredElevation = 0.dp, disabledElevation = 0.dp)
    if (primary || danger) Button(onClick, size, enabled,
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = if (danger) TerminalTokens.error else TerminalTokens.primary,
            contentColor = if (danger) TerminalTokens.onError else TerminalTokens.onPrimary,
            disabledContainerColor = TerminalTokens.raised, disabledContentColor = TerminalTokens.muted),
        elevation = flat,
        contentPadding = PaddingValues(TerminalTokens.md), content = text)
    else Button(onClick, size, enabled, shape = MaterialTheme.shapes.small,
        border = BorderStroke(TerminalTokens.stroke, TerminalTokens.border),
        colors = ButtonDefaults.buttonColors(containerColor = TerminalTokens.raised,
            contentColor = TerminalTokens.text,
            disabledContainerColor = TerminalTokens.surface, disabledContentColor = TerminalTokens.muted),
        elevation = flat,
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
