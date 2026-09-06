package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.scanner.ScannerCapture

internal fun TerminalPhase.tone() = when (this) {
    TerminalPhase.SUCCESS -> TerminalTone.SUCCESS
    TerminalPhase.ERROR -> TerminalTone.ERROR
    TerminalPhase.WARNING, TerminalPhase.OFFLINE -> TerminalTone.WARNING
    else -> TerminalTone.NEUTRAL
}
internal fun TerminalPhase.icon() = when (this) {
    TerminalPhase.SUCCESS -> TerminalIcon.SUCCESS
    TerminalPhase.ERROR -> TerminalIcon.ERROR
    TerminalPhase.WARNING -> TerminalIcon.WARNING
    TerminalPhase.OFFLINE -> TerminalIcon.OFFLINE
    TerminalPhase.EMPTY -> TerminalIcon.QUEUE
    else -> TerminalIcon.SCANNER
}

@Composable
internal fun ReceivingStatus(view: ReceivingPresentation, large: Boolean) {
    val feedback = view.feedback
    val color = if (feedback.phase in setOf(TerminalPhase.READY, TerminalPhase.SCANNING, TerminalPhase.VALIDATING, TerminalPhase.WAITING))
        TerminalTokens.text else feedback.phase.tone().color()
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }.testTag("RECEIVING_FEEDBACK"),
        horizontalAlignment = if (large) Alignment.CenterHorizontally else Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            WorkerIcon(feedback.phase.icon(), null, Modifier.size(if (large) TerminalTokens.workflowIcon else TerminalTokens.icon), color)
            Text(feedback.title, style = if (large) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleMedium,
                color = color, modifier = Modifier.testTag("SCAN_STATUS_TITLE"))
        }
        feedback.code?.let { BarcodeDisplay(it) }
        if (feedback.detail.isNotBlank() && !(large && feedback.phase == TerminalPhase.READY)) Text(feedback.detail, style = MaterialTheme.typography.bodyLarge,
            color = TerminalTokens.muted, modifier = Modifier.testTag("SCAN_STATUS_DETAIL"))
    }
}

@Composable
internal fun ManualScan(capture: ScannerCapture, enabled: Boolean) {
    TerminalTextInput("MANUAL CODE", capture.manualCode, capture.setCode, enabled = enabled, onSubmit = capture.submit)
    PrimaryAction("SUBMIT CODE", capture.submit, enabled && capture.manualCode.isNotBlank())
    SecondaryAction("CLOSE KEYPAD", capture.manual, enabled)
}

@Composable
internal fun ReceivingReview(view: ReceivingPresentation, send: (ReceivingIntent) -> Unit, compact: Boolean) {
    val state = view.workflow
    when (state.step) {
        ReceivingStep.CONFIRM_CARTON -> state.carton?.let {
            LocationBlock(it.code, label = if (it.alreadyReceived) "RECEIVED CARTON · CONFIRM SOURCE" else "CARTON TO RECEIVE")
        }
        ReceivingStep.REVIEW_PRODUCT -> state.product?.let {
            ProductBlock(it.product?.productName, it.scan.value)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                QuantityDisplay("EXPECTED", it.product?.expected?.toString() ?: "—", Modifier.weight(1f))
                QuantityDisplay("REMAINING", it.product?.remaining?.toString() ?: "—", Modifier.weight(1f))
            }
            QuantityInput(it.quantity, { value -> send(ReceivingIntent.Quantity(value)) }, state.canMutate)
            Text("Receive one physical unit. Set damaged items aside and report the problem.", style = MaterialTheme.typography.bodyMedium)
            state.tote?.let { tote -> Text("TOTE · ${tote.code}", style = MaterialTheme.typography.titleMedium) }
            state.message?.takeIf { it.tone == MessageTone.ERROR }?.let { issue -> ErrorState(issue.title, issue.detail) }
        }
        ReceivingStep.RESULT -> state.receipt?.let {
            BarcodeDisplay(it.articleCode)
            Text("${it.sku} · ${it.toteCode}", style = MaterialTheme.typography.titleMedium)
            Text("Check the unit is in its tote, then acknowledge.", style = MaterialTheme.typography.bodyLarge)
        }
        ReceivingStep.REVIEW_COMPLETE -> {
            state.session?.let {
                ProgressIndicator(it.tally.receivedCartons, it.tally.expectedCartons, "CARTONS")
                ProgressIndicator(it.tally.receivedUnits, it.tally.expectedUnits, "UNITS")
                Text("${it.tally.openDiscrepancies} OPEN PROBLEMS", style = MaterialTheme.typography.titleMedium)
            }
            if (state.hasVariance && !state.canResolve) WarningState("SUPERVISOR REQUIRED", "Ask your supervisor to check differences before closing receiving.")
            SecondaryAction("CONTINUE SCANNING", { send(ReceivingIntent.NextProduct) }, state.canMutate)
        }
        else -> if (!compact) state.tote?.let { LocationBlock(it.code, label = "RECEIVING TOTE") }
    }
}

@Composable
internal fun ReceivingFooter(view: ReceivingPresentation, send: (ReceivingIntent) -> Unit,
    back: () -> Unit, more: () -> Unit, refresh: () -> Unit, industrial: Boolean) {
    val state = view.workflow
    TerminalFooter(if (state.busy) "PLEASE WAIT" else if (state.pending?.confirmedReceipt != null) "CHECK PHYSICAL PLACEMENT" else "") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            TerminalIconAction(TerminalIcon.BACK, "Back to work queue", back, !state.busy)
            Box(Modifier.weight(1f)) {
                when {
                    !state.serverAvailable -> PrimaryAction("RECONNECT", refresh, !state.busy)
                    state.step == ReceivingStep.CONFIRM_CARTON -> PrimaryAction(if (state.carton?.alreadyReceived == true) "CONFIRM SOURCE" else "CONFIRM CARTON",
                        { send(ReceivingIntent.ConfirmCarton) }, state.canMutate)
                    state.step == ReceivingStep.REVIEW_PRODUCT -> PrimaryAction("CONFIRM 1 UNIT", { send(ReceivingIntent.ConfirmProduct) }, state.canMutate)
                    state.step == ReceivingStep.RESULT -> PrimaryAction("ACKNOWLEDGE", { send(ReceivingIntent.NextProduct) }, state.canAcknowledgeReceipt)
                    state.step == ReceivingStep.REVIEW_COMPLETE -> PrimaryAction("COMPLETE", { send(ReceivingIntent.Complete) }, state.canComplete)
                    state.step == ReceivingStep.PAUSED -> PrimaryAction("RESUME", { send(ReceivingIntent.Resume) }, state.canMutate)
                    state.step == ReceivingStep.COMPLETE -> PrimaryAction("NEXT ARRIVAL", { send(ReceivingIntent.NextArrival) }, state.canMutate)
                    state.step == ReceivingStep.RECONCILE -> SecondaryAction("CHECK RECEIPT", refresh, !state.busy)
                    view.emptyQueue -> SecondaryAction("REFRESH QUEUE", refresh, !state.busy)
                    industrial -> TerminalModeSelector("CARTON", "PRODUIT", state.mode == ReceivingMode.CARTONS, state.canSelectMode,
                        { send(ReceivingIntent.SelectMode(ReceivingMode.CARTONS)) }, { send(ReceivingIntent.SelectMode(ReceivingMode.PRODUCTS)) }, padded = false)
                    else -> SecondaryAction("TASK ACTIONS", more, state.canManageTask)
                }
            }
            TerminalIconAction(TerminalIcon.MENU, "Task actions", more, !state.busy)
        }
    }
}
