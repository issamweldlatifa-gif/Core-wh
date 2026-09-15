package com.ayrovi.worker.printer

/**
 * PRINTER ABSTRACTION (task §31/§32): the manager, queue and tests depend on
 * these interfaces only — Android classes live in the implementations, so
 * future transports (USB / Wi-Fi / another engine) plug in without touching
 * business code.
 */

/** Thrown by transports/discovery on failure; [error] is user-facing. */
class PrinterException(val error: PrinterError) : RuntimeException(error.userMessage)

/** Byte pipe to ONE printer link (SPP today, USB/Wi-Fi later). */
interface PrinterTransport {
    val connected: Boolean
    fun connect(address: String)
    fun write(data: ByteArray)
    fun disconnect()
}

/** Printer lookup: paired devices + live radio discovery. */
interface PrinterFinder {
    fun bonded(): List<PrinterInfo>
    /** Runs a bounded scan; callbacks arrive on any thread. Returns false when scanning is impossible. */
    fun startScan(onDevice: (PrinterInfo) -> Unit, onFinished: () -> Unit): Boolean
    fun stopScan()
}

/** Saved-printer + job-id persistence on the CT40 (task §11/§18). */
interface PrinterPersistence {
    fun loadSaved(): PrinterInfo?
    fun saveSaved(printer: PrinterInfo)
    fun clearSaved()
    fun seenJob(jobId: String): Boolean
    fun rememberJob(jobId: String)
    fun bridgeEnabled(): Boolean
    fun setBridgeEnabled(enabled: Boolean)
}
