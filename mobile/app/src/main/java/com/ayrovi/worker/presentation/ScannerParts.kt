package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.ayrovi.worker.design.BarcodeDisplay
import com.ayrovi.worker.design.ErrorState
import com.ayrovi.worker.design.PrimaryAction
import com.ayrovi.worker.design.SecondaryAction
import com.ayrovi.worker.design.TerminalTextInput
import com.ayrovi.worker.design.TerminalTokens
import com.ayrovi.worker.scanner.ScannerCapture

/**
 * Shared scanner TOOL surfaces (MASTER ORDER §§21–24). They are the pieces the
 * unified [ScannerPanel] shows while a camera tool is in use — never a
 * permanent cluster of buttons on the scanner screen.
 *
 * Manual entry is a fallback only (§24): a single field, submit, and the tool
 * closes on success (the result state then shows in the foreground).
 */
@Composable
internal fun ManualScan(capture: ScannerCapture, enabled: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("MANUAL_SCAN"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        Text("MANUAL CODE", style = MaterialTheme.typography.titleSmall, color = TerminalTokens.warning)
        TerminalTextInput("CODE", capture.manualCode, capture.setCode, enabled = enabled, onSubmit = capture.submit)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
            PrimaryAction("SUBMIT CODE", capture.submit, enabled && capture.manualCode.isNotBlank(), Modifier.weight(1f))
            SecondaryAction("CLOSE TOOL", capture.cancel, enabled, Modifier.weight(1f))
        }
    }
}

/**
 * OCR tool, camera NOT streaming yet (§17/§22): the chooser / typing fallback.
 * The live camera itself takes over the whole screen (CameraToolOverlay): the
 * strip on the full screen width, everything else fogged, BACK only. ML Kit
 * detects, the strict pattern filters (`^s[a-z][0-9]{5,20}$`), and only the
 * VALIDATED code is shown: the raw engine text is never displayed.
 *
 * The tool closes itself as soon as a code is confirmed or a scan succeeds
 * (§21), so the operator lands on the result state of the current workflow.
 */
@Composable
internal fun OcrScan(capture: ScannerCapture, enabled: Boolean) {
    var typed by remember { mutableStateOf(false) }
    val candidate = capture.ocrSuggestion?.candidate
    Column(Modifier.fillMaxWidth().testTag("OCR_SCAN"), verticalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
        when {
            typed -> {
                TerminalTextInput("LABEL TEXT", capture.ocrText, capture.setOcrText, enabled = enabled, singleLine = false, onSubmit = capture.submitOcr)
                candidate?.let { BarcodeDisplay(it) }
                capture.ocrError?.let { ErrorState("NO CODE FOUND", it) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    PrimaryAction("SUBMIT CODE", capture.submitOcr, enabled && capture.ocrText.isNotBlank(), Modifier.weight(1f))
                    SecondaryAction("CLOSE TOOL", capture.cancel, enabled, Modifier.weight(1f))
                }
            }
            else -> {
                Text(
                    "Reads the product SKU shape s + one lowercase letter + 5–20 digits.",
                    style = MaterialTheme.typography.bodySmall, color = TerminalTokens.muted,
                )
                capture.ocrError?.let { ErrorState("NO CODE FOUND", it) }
                PrimaryAction("OPEN OCR CAMERA", capture.ocrCamera, enabled)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(TerminalTokens.xs)) {
                    SecondaryAction("TYPE / PASTE", { typed = true }, enabled, Modifier.weight(1f))
                    SecondaryAction("CLOSE TOOL", capture.cancel, enabled, Modifier.weight(1f))
                }
            }
        }
    }
}
