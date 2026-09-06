package com.ayrovi.worker.presentation.phone

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.ayrovi.worker.design.*
import com.ayrovi.worker.domain.*
import com.ayrovi.worker.presentation.*
import com.ayrovi.worker.scanner.ScannerCapture

/** Touch-first presentation only. All commands go through the same ReceivingViewModel. */
@Composable
internal fun PhoneReceiving(
    view: ReceivingPresentation, capture: ScannerCapture, enabled: Boolean,
    worker: String, station: String?, connection: String, send: (ReceivingIntent) -> Unit,
    back: () -> Unit, more: () -> Unit, settings: () -> Unit, refresh: () -> Unit,
) {
    TerminalShell(
        header = { TerminalHeader("RECEIVING", worker, station, connection, onSettings = settings) },
        toolbar = { TerminalModeSelector("CARTON", "PRODUIT", view.workflow.mode == ReceivingMode.CARTONS, view.workflow.canSelectMode,
            { send(ReceivingIntent.SelectMode(ReceivingMode.CARTONS)) }, { send(ReceivingIntent.SelectMode(ReceivingMode.PRODUCTS)) }) },
        footer = { ReceivingFooter(view, send, back, more, refresh, industrial = false) },
        scrollKey = view.workflow.step,
    ) {
        Column(Modifier.fillMaxWidth().testTag("PHONE_RECEIVING"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.md)) {
            if (!view.emptyQueue) {
                view.step?.let { StepIndicator(it, 7, "RECEIVING") }
                TaskInstruction(view.instruction)
            }
            if (view.workflow.session != null) view.workflow.session?.let { Text(it.arrival.code ?: it.code, style = MaterialTheme.typography.bodyMedium, color = TerminalTokens.muted) }
            ReceivingStatus(view, large = false)
            if (view.captureVisible && !view.emptyQueue) {
                when {
                    capture.manualOpen -> ManualScan(capture, enabled)
                    capture.cameraOpen -> {
                        capture.preview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
                        SecondaryAction("CANCEL SCAN", capture.cancel)
                    }
                    else -> {
                        Box(Modifier.fillMaxWidth().height(TerminalTokens.stateIcon), contentAlignment = Alignment.Center) {
                            WorkerIcon(TerminalIcon.SCANNER, "Scanner", Modifier.size(TerminalTokens.stateIcon), TerminalTokens.instruction)
                        }
                        PrimaryAction("SOFTWARE SCAN", capture.softwareScan, enabled)
                        SecondaryAction("USE CAMERA", capture.camera, enabled)
                        TextButton(capture.manual, Modifier.fillMaxWidth().heightIn(min = TerminalTokens.touch), enabled) {
                            WorkerIcon(TerminalIcon.MANUAL, null, Modifier.size(TerminalTokens.icon))
                            Spacer(Modifier.width(TerminalTokens.xs)); Text("MANUAL CODE")
                        }
                    }
                }
            }
            ReceivingReview(view, send, compact = false)
            if (view.workflow.step == ReceivingStep.ARRIVAL && view.workflow.arrivals.isNotEmpty()) {
                Text("WAITING ARRIVALS", style = MaterialTheme.typography.labelMedium)
                view.workflow.arrivals.take(20).forEach { arrival ->
                    SecondaryAction(arrival.code ?: arrival.id.orEmpty(), { send(ReceivingIntent.OpenArrival(arrival.code ?: arrival.id.orEmpty())) }, view.workflow.canMutate)
                }
                if (view.workflow.arrivals.size > 20) Text("Scan the arrival label to open other waiting arrivals.", style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
