package com.ayrovi.worker.scanner

/** Capture modes a device offers for a directed-OCR template. Order = UI order. */
enum class CaptureMode { BARCODE, OCR }

/**
 * Which capture modes each device offers (pure policy, fully unit-testable).
 *
 * Both devices are barcode-first: the phone uses the camera barcode adapter,
 * the CT40 its side trigger. OCR is the label-text fallback for damaged or
 * missing barcodes — on the CT40 it is an explicit fallback, never the
 * default path.
 */
object DeviceScanModes {
    fun modes(device: WorkerDevice): List<CaptureMode> = when (device) {
        WorkerDevice.PHONE -> listOf(CaptureMode.BARCODE, CaptureMode.OCR)
        WorkerDevice.CT40 -> listOf(CaptureMode.BARCODE, CaptureMode.OCR)
    }

    fun primary(device: WorkerDevice): CaptureMode = modes(device).first()

    fun supportsOcr(device: WorkerDevice): Boolean = modes(device).contains(CaptureMode.OCR)

    fun ocrIsFallback(device: WorkerDevice): Boolean = device == WorkerDevice.CT40
}
