package com.ayrovi.worker.scanner

import android.content.Context

/** Foreground scanner owner; not a background Android Service that scans outside a task. */
class ScannerService(context: Context, val coordinator: ScanCoordinator) {
    private val honeywell = HoneywellScanner(context, onBarcode = {
        coordinator.onScanned(it, false, ScanSource.EXTERNAL_SCANNER.name, ScanSymbology.BARCODE)
    })
    private val zebra = ZebraDataWedgeScanner(context) { value, symbology ->
        coordinator.onScanned(value, false, ScanSource.EXTERNAL_SCANNER.name, symbology)
    }
    val supportsSoftwareTrigger: Boolean get() = ZebraDataWedgeScanner.isZebraDevice()
    val hasHardware: Boolean get() = HoneywellScanner.isHoneywellDevice() || ZebraDataWedgeScanner.isZebraDevice()

    private var started = false
    private var initialized = false
    fun initialize() { if (!initialized) { coordinator.manager.setEnabled(false); initialized = true } }
    fun isAvailable(): Boolean = started && (!HoneywellScanner.isHoneywellDevice() || honeywell.isActive)
    fun start() {
        try { honeywell.start(); zebra.start(); started = true }
        catch (_: Exception) { started = false; coordinator.unavailable("Scanner unavailable. Use manual entry or ask your supervisor.") }
    }
    fun stop() { started = false; honeywell.stop(); zebra.stop() }
    fun softwareTrigger(): Boolean = try { zebra.softTrigger() } catch (_: Exception) { false }
}
