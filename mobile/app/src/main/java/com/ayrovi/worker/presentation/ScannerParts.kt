package com.ayrovi.worker.presentation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.ayrovi.worker.design.*
import com.ayrovi.worker.scanner.ScannerCapture

/**
 * Shared scanner capture pieces (EXISTING scanner stack, unchanged):
 * manual keypad entry and the operator-confirmed OCR review. Both funnel
 * into the same scan pipeline as camera / CT40 trigger reads.
 */
@Composable
internal fun ManualScan(capture: ScannerCapture, enabled: Boolean) {
    TerminalTextInput("MANUAL CODE", capture.manualCode, capture.setCode, enabled = enabled, onSubmit = capture.submit)
    PrimaryAction("SUBMIT CODE", capture.submit, enabled && capture.manualCode.isNotBlank())
    SecondaryAction("CLOSE KEYPAD", capture.manual, enabled)
}

/** OCR review: multi-line label text in, operator-confirmed code out. Nothing auto-submits. */
@Composable
internal fun OcrScan(capture: ScannerCapture, enabled: Boolean) {
    Column(Modifier.fillMaxWidth().testTag("OCR_SCAN"), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(TerminalTokens.xs)) {
        if (capture.ocrCameraOpen) {
            capture.ocrPreview(Modifier.fillMaxWidth().height(TerminalTokens.scanPreview))
            SecondaryAction("CANCEL SCAN", capture.ocrCamera, enabled)
        } else {
            TerminalTextInput("LABEL TEXT", capture.ocrText, capture.setOcrText, enabled = enabled, singleLine = false, onSubmit = capture.submitOcr)
            capture.ocrSuggestion?.candidate?.let { BarcodeDisplay(it) }
            capture.ocrError?.let { ErrorState("NO CODE FOUND", it) }
            SecondaryAction("SCAN WITH CAMERA", capture.ocrCamera, enabled)
            PrimaryAction("SUBMIT CODE", capture.submitOcr, enabled && capture.ocrText.isNotBlank())
            SecondaryAction("CLOSE OCR", capture.ocr, enabled)
        }
    }
}
