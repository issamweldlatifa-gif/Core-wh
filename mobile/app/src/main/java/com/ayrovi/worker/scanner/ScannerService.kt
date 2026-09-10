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
    /**
     * Hardware is available ONLY when a real imager/DataWedge exists: a
     * Honeywell terminal with its scanner claimed, or a Zebra device. A
     * plain phone (or emulator) has no hardware trigger, so this is false
     * there — the UI then shows the phone illustration + software trigger
     * instead of the CT40 glyph. (The old `!isHoneywell || isActive`
     * expression was true on every phone — the field-reported bug where the
     * app claimed CT40 on a phone.)
     */
    fun isAvailable(): Boolean = started && ((HoneywellScanner.isHoneywellDevice() && honeywell.isActive) || ZebraDataWedgeScanner.isZebraDevice())
    fun start() {
        try { honeywell.start(); zebra.start(); started = true }
        catch (_: Exception) { started = false; coordinator.unavailable("Scanner unavailable. Use manual entry or ask your supervisor.") }
    }
    fun stop() { started = false; honeywell.stop(); zebra.stop() }
    fun softwareTrigger(): Boolean = try { zebra.softTrigger() } catch (_: Exception) { false }
}
