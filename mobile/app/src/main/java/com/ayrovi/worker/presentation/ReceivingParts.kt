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

/** OCR review: multi-line label text in, operator-confirmed SKU out. Nothing auto-submits. */
@Composable
internal fun OcrScan(capture: ScannerCapture, enabled: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("OCR_SCAN"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        if (capture.ocrCameraOpen) {
            capture.ocrPreview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
            SecondaryAction("CANCEL SCAN", capture.ocrCamera)
        } else {
            TerminalTextInput("LABEL TEXT", capture.ocrText, capture.setOcrText, enabled = enabled, singleLine = false, onSubmit = capture.submitOcr)
            capture.ocrSuggestion?.candidate?.let { BarcodeDisplay(it) }
            capture.ocrError?.let { ErrorState("NO SKU FOUND", it) }
            SecondaryAction("SCAN WITH CAMERA", capture.ocrCamera, enabled)
            PrimaryAction("SUBMIT SKU", capture.submitOcr, enabled && capture.ocrText.isNotBlank())
            SecondaryAction("CLOSE OCR", capture.ocr, enabled)
        }
    }
}

/**
 * Card review for the two lanes. The device already matched the scanned
 * identifier against the expected card data; CONFIRM is the only path to a
 * backend write. The two card types are rendered independently, never merged.
 */
@Composable
internal fun ReceivingReview(view: ReceivingPresentation, send: (ReceivingIntent) -> Unit, compact: Boolean) {
    val state = view.workflow
    when (state.step) {
        ReceivingStep.REVIEW_PRODUCT -> state.product?.let { review ->
            ProductBlock(review.card.productName, review.scan.value)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                QuantityDisplay("EXPECTED", review.card.expected.toString(), Modifier.weight(1f))
                QuantityDisplay("RECEIVED", review.card.received.toString(), Modifier.weight(1f))
                QuantityDisplay("REMAINING", review.card.remaining.toString(), Modifier.weight(1f))
            }
            ScanBadge(review.scan.scanType, review.card.sku ?: review.card.reference)
            Text("Confirming receives one physical unit against this product card.", style = MaterialTheme.typography.bodyMedium)
            state.message?.takeIf { it.tone == MessageTone.ERROR }?.let { issue -> ErrorState(issue.title, issue.detail) }
        }
        ReceivingStep.REVIEW_CARTON -> state.carton?.let { review ->
            LocationBlock(review.card.externalCartonId ?: review.scan.value, label = "CARTON TO RECEIVE")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.sm)) {
                QuantityDisplay("MATCHED ON", review.matchedOn, Modifier.weight(1f))
                QuantityDisplay("CARTON", "${review.card.cartonNumber}/${review.card.totalCartons}", Modifier.weight(1f))
            }
            review.card.trackingNumber?.let { Text("TRACKING · $it", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
            review.card.senderName?.let { Text("SENDER · $it", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
            ScanBadge(review.scan.scanType, review.scan.value)
            Text("Confirming records this carton as received. It cannot be counted twice.", style = MaterialTheme.typography.bodyMedium)
        }
        ReceivingStep.REVIEW_COMPLETE -> {
            state.session?.let {
                ProgressIndicator(it.tally.receivedCartons, it.tally.expectedCartons, "CARTONS")
                ProgressIndicator(it.tally.receivedUnits, it.tally.expectedUnits, "UNITS")
                Text("${it.tally.openDiscrepancies} OPEN PROBLEMS", style = MaterialTheme.typography.titleMedium)
            }
            if (state.hasVariance && !state.canResolve) WarningState("SUPERVISOR REQUIRED", "Ask your supervisor to check differences before closing receiving.")
            SecondaryAction("CONTINUE SCANNING", { send(ReceivingIntent.ContinueScanning) }, state.canMutate)
        }
        else -> Unit
    }
}

/** Scan provenance line (QR / BARCODE / OCR / MANUAL) for the card under review. */
@Composable
private fun ScanBadge(scanType: String, code: String?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
        WorkerIcon(TerminalIcon.SCANNER, null, Modifier.size(TerminalTokens.iconSmall))
        Text(scanType, style = MaterialTheme.typography.labelLarge)
        code?.let { Text("· $it", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted) }
    }
}

@Composable
internal fun ReceivingFooter(view: ReceivingPresentation, send: (ReceivingIntent) -> Unit,
    back: () -> Unit, more: () -> Unit, refresh: () -> Unit, industrial: Boolean) {
    val state = view.workflow
    TerminalFooter(if (state.busy) "PLEASE WAIT" else "") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
            TerminalIconAction(TerminalIcon.BACK, "Back to work queue", back, !state.busy)
            Box(Modifier.weight(1f)) {
                when {
                    !state.serverAvailable -> PrimaryAction("RECONNECT", refresh, !state.busy)
                    state.step == ReceivingStep.REVIEW_PRODUCT -> PrimaryAction("CONFIRM", { send(ReceivingIntent.ConfirmCard) }, state.canConfirm)
                    state.step == ReceivingStep.REVIEW_CARTON -> PrimaryAction("CONFIRM", { send(ReceivingIntent.ConfirmCard) }, state.canConfirm)
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
        // Reviews get an explicit cancel next to CONFIRM — never an auto-submit.
        if (state.step in setOf(ReceivingStep.REVIEW_PRODUCT, ReceivingStep.REVIEW_CARTON)) {
            SecondaryAction("CANCEL", { send(ReceivingIntent.ContinueScanning) }, state.canMutate)
        }
    }
}
