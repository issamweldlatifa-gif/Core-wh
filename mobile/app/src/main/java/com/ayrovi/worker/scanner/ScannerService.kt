package com.ayrovi.worker.scanner

import android.content.Context

/** Foreground scanner owner; not a background Android Service that scans outside a task. */
class ScannerService(context: Context, val coordinator: ScanCoordinator) {
    private val honeywell = HoneywellScanner(context) {
        coordinator.onScanned(it, false, ScanSource.EXTERNAL_SCANNER.name, ScanSymbology.BARCODE)
    }
    private val zebra = ZebraDataWedgeScanner(context) { value, symbology ->
        coordinator.onScanned(value, false, ScanSource.EXTERNAL_SCANNER.name, symbology)
    }
    val supportsSoftwareTrigger: Boolean get() = ZebraDataWedgeScanner.isZebraDevice()
    val hasHardware: Boolean get() = HoneywellScanner.isHoneywellDevice() || ZebraDataWedgeScanner.isZebraDevice()

    fun start() {
        try { honeywell.start(); zebra.start() }
        catch (_: Exception) { coordinator.unavailable("Hardware scanner unavailable — use camera or manual entry") }
    }
    fun stop() { honeywell.stop(); zebra.stop() }
    fun softwareTrigger(): Boolean = try { zebra.softTrigger() } catch (_: Exception) { false }
}
