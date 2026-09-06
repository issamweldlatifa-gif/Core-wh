package com.ayrovi.worker.presentation.ct40

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.presentation.*
import com.ayrovi.worker.scanner.ScannerCapture

/** Scanner-first native terminal, not a resized PhoneReceiving. Real side-trigger input owns capture. */
@Composable
internal fun CT40Receiving(
    view: ReceivingPresentation, capture: ScannerCapture, enabled: Boolean,
    worker: String, station: String?, connection: String, send: (ReceivingIntent) -> Unit,
    back: () -> Unit, more: () -> Unit, settings: () -> Unit, refresh: () -> Unit,
) {
    val fontScale = LocalDensity.current.fontScale
    Column(Modifier.fillMaxSize().background(TerminalTokens.background).safeDrawingPadding().imePadding().testTag("CT40_RECEIVING")) {
        TerminalHeader("RECEIVING", worker, station, connection, industrial = true, onSettings = settings)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // Adaptive fitting INSIDE CT40 mode; never used to classify a device.
            val illustrationSize = when {
                fontScale > 1.2f -> TerminalTokens.stateIcon
                maxHeight < TerminalTokens.deviceVisual * 3.5f -> TerminalTokens.compactDeviceVisual
                else -> TerminalTokens.deviceVisual
            }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = TerminalTokens.xs, vertical = TerminalTokens.xxs),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                if (!view.emptyQueue) Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
                    view.step?.let { StepIndicator(it, 7, "RECEIVING") }
                    Text(view.instruction, style = MaterialTheme.typography.headlineMedium)
                }
                if (view.captureVisible && !capture.manualOpen && !capture.cameraOpen && !view.emptyQueue) {
                    CT40DeviceVisual(view.feedback.phase, Modifier.height(illustrationSize))
                }
                ReceivingStatus(view, large = true)
                if (view.workflow.step == ReceivingStep.ARRIVAL && view.workflow.arrivals.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xxs)) {
                        WorkerIcon(TerminalIcon.QUEUE, null, Modifier.size(TerminalTokens.iconSmall), TerminalTokens.instruction)
                        Text("WAITING ARRIVALS", style = MaterialTheme.typography.labelLarge)
                    }
                    view.workflow.arrivals.take(20).forEach { arrival ->
                        val arrivalCode = arrival.code ?: arrival.id.orEmpty()
                        val label = listOfNotNull(arrivalCode, arrival.customerName?.take(24)).joinToString(" · ")
                        SecondaryAction(label, { send(ReceivingIntent.OpenArrival(arrivalCode)) }, view.workflow.canMutate)
                    }
                    if (view.workflow.arrivals.size > 20)
                        Text("Scan the arrival label to open other waiting arrivals.", style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted)
                }
                when {
                    view.emptyQueue -> WorkerIcon(TerminalIcon.QUEUE, null, Modifier.size(TerminalTokens.stateIcon), TerminalTokens.muted)
                    view.captureVisible && capture.manualOpen -> ManualScan(capture, enabled)
                    capture.cameraOpen -> {
                        // Explicit emergency fallback, never the normal CT40 path.
                        capture.preview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
                        SecondaryAction("CANCEL CAMERA", capture.cancel)
                    }
                    view.captureVisible && !view.feedback.transient -> {
                        if (fontScale <= 1.2f) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                            WorkerIcon(TerminalIcon.SCANNER, null, Modifier.size(TerminalTokens.iconSmall))
                            Text(view.target, style = MaterialTheme.typography.labelLarge)
                            Text("· CODE", style = MaterialTheme.typography.labelMedium, color = TerminalTokens.muted)
                        }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (!enabled) "Wait before scanning" else if (capture.hardwareAvailable) "Use the side trigger" else "Use manual entry", style = MaterialTheme.typography.bodyMedium,
                                color = TerminalTokens.muted, modifier = Modifier.weight(1f))
                            TextButton(capture.manual, Modifier.heightIn(min = TerminalTokens.touch), enabled) {
                                WorkerIcon(TerminalIcon.MANUAL, null, Modifier.size(TerminalTokens.iconSmall))
                                Spacer(Modifier.width(TerminalTokens.xxs)); Text("MANUAL CODE")
                            }
                        }
                    }
                }
                ReceivingReview(view, send, compact = true)
            }
        }
        ReceivingFooter(view, send, back, more, refresh, industrial = true)
    }
}
