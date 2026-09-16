package com.ayrovi.worker.printer

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet

/**
 * PRINTER MANAGER — the single facade the bridge (and any future UI) talks
 * to (task §10). Owns the state machine, auto-reconnect policy (task §12),
 * test/QR/barcode printing and duplicate protection. NO Android imports —
 * everything device-specific sits behind [PrinterTransport],
 * [PrinterFinder], [PrinterPersistence].
 */
class PrinterManager(
    private val persistence: PrinterPersistence,
    private val transport: PrinterTransport,
    private val finder: PrinterFinder,
    private val queue: PrintQueue,
    private val clock: () -> Long = System::currentTimeMillis,
) {

    @Volatile
    var state: PrinterConnectionState = PrinterConnectionState.DISCONNECTED
        private set

    @Volatile
    var lastError: PrinterError? = null
        private set

    @Volatile
    var connectedPrinter: PrinterInfo? = null
        private set

    private val listeners = CopyOnWriteArraySet<(PrinterConnectionState, String?) -> Unit>()

    fun addListener(listener: (PrinterConnectionState, String?) -> Unit) { listeners.add(listener) }
    fun removeListener(listener: (PrinterConnectionState, String?) -> Unit) { listeners.remove(listener) }

    private fun setState(next: PrinterConnectionState, detail: String? = null) {
        state = next
        listeners.forEach { it(next, detail) }
    }

    private fun fail(error: PrinterError): Boolean {
        lastError = error
        setState(PrinterConnectionState.ERROR, error.userMessage)
        return false
    }

    // ------------------------------------------------------------ discovery

    /** Paired printers first (the owner paired PM-241-BT once via Labelife —
     *  the bond stays; printing itself never needs Labelife). */
    fun bondedPrinters(): List<PrinterInfo> = try {
        finder.bonded()
    } catch (e: PrinterException) {
        lastError = e.error; emptyList()
    }

    /** Live radio scan (bounded by the finder). False = cannot scan right now. */
    fun scan(onDevice: (PrinterInfo) -> Unit, onFinished: () -> Unit): Boolean = try {
        setState(PrinterConnectionState.DISCONNECTED)
        finder.startScan(onDevice, onFinished)
    } catch (e: PrinterException) {
        lastError = e.error
        setState(PrinterConnectionState.ERROR, e.error.userMessage)
        false
    }

    fun stopScan() { finder.stopScan() }

    // ------------------------------------------------------------ connection

    fun connect(address: String, name: String?): Boolean {
        if (address.isBlank()) return fail(PrinterError("BAD_ADDRESS", "Printer not found."))
        val already = transport.connected
        if (already && connectedPrinter?.address == address) return true
        setState(PrinterConnectionState.CONNECTING)
        try {
            transport.connect(address)
        } catch (e: PrinterException) {
            return fail(e.error)
        } catch (e: Exception) {
            return fail(PrinterError("CONNECT_FAILED", "Printer disconnected.", e.message))
        }
        val saved = persistence.loadSaved()
        val info = PrinterInfo(
            name = name ?: saved?.takeIf { it.address == address }?.name ?: address,
            address = address,
            model = saved?.takeIf { it.address == address }?.model,
            firmware = saved?.takeIf { it.address == address }?.firmware,
            lastConnectedAt = clock(),
            lastStatus = "CONNECTED",
        )
        connectedPrinter = info
        persistence.saveSaved(info)
        lastError = null
        setState(PrinterConnectionState.CONNECTED)
        return true
    }

    fun disconnect() {
        try { transport.disconnect() } catch (_: Exception) { /* best effort */ }
        connectedPrinter = null
        setState(PrinterConnectionState.DISCONNECTED)
    }

    /** Controlled reconnect (task §12): bounded attempts, 1.5 s apart. */
    fun reconnect(maxAttempts: Int = 3): Boolean {
        val target = connectedPrinter ?: persistence.loadSaved() ?: run {
            lastError = PrinterError("NO_PRINTER", "Printer unavailable.")
            setState(PrinterConnectionState.ERROR, "Printer unavailable.")
            return false
        }
        for (attempt in 1..maxAttempts) {
            if (connect(target.address, target.name)) return true
            if (attempt < maxAttempts) {
                try { Thread.sleep(1_500) } catch (_: InterruptedException) { return false }
            }
        }
        return false
    }

    /** Called by the Android layer when the ACL link drops (task §19). */
    fun onConnectionLost(reason: String) {
        if (state == PrinterConnectionState.CONNECTED || state == PrinterConnectionState.PRINTING) {
            try { transport.disconnect() } catch (_: Exception) { /* already gone */ }
            connectedPrinter = null
            lastError = PrinterError("LINK_LOST", "Printer connection lost.", reason)
            setState(PrinterConnectionState.DISCONNECTED, "Printer connection lost.")
        }
    }

    fun status(): ManagerStatus = ManagerStatus(
        state = state,
        savedPrinter = persistence.loadSaved(),
        connectedName = connectedPrinter?.name,
        connectedAddress = connectedPrinter?.address,
        firmware = connectedPrinter?.firmware,
        lastError = lastError,
    )

    // ------------------------------------------------------------ printing

    private fun requireConnected(): Boolean {
        if (!transport.connected) {
            lastError = PrinterError("NOT_CONNECTED", "Printer disconnected.")
            setState(PrinterConnectionState.ERROR, "Printer disconnected.")
            return false
        }
        return true
    }

    /**
     * ONE job through the queue; blocks until the bytes are written (the
     * bridge calls this from its request thread — the Bluetooth link stays
     * strictly sequential, task §17).
     *
     * A job without an id is REFUSED, never printed: the id is the only thing
     * that makes a print exactly-once (it is what the queue remembers and what
     * the server is told), so a caller that sends none would otherwise get a
     * fresh label on every retry — precisely the duplicate the owner forbids.
     * The refusal is a caller mistake, not a printer fault: the link state is
     * left untouched.
     */
    fun print(jobId: String, spec: LabelSpec): PrintOutcome {
        if (jobId.isBlank()) {
            return PrintOutcome(
                ok = false,
                duplicate = false,
                error = PrinterError(
                    "JOB_ID_REQUIRED",
                    "Printing needs a job id — it is what stops the same label printing twice.",
                ),
            )
        }
        if (persistence.seenJob(jobId)) return PrintOutcome(ok = true, duplicate = true)
        if (!requireConnected()) return PrintOutcome(ok = false, duplicate = false, error = lastError)
        val commands = TsplEncoder.encode(spec, connectedPrinter?.name)
        setState(PrinterConnectionState.PRINTING)
        val latch = java.util.concurrent.CountDownLatch(1)
        var outcome = PrintOutcome(ok = false, duplicate = false, error = PrinterError("TIMEOUT", "Printing failed. Check the printer."))
        queue.submit(jobId, commands) { result ->
            outcome = result
            latch.countDown()
        }
        latch.await()
        if (!outcome.ok) {
            // Write failed mid-job → the link is unreliable: mark lost (task §19).
            lastError = outcome.error
            setState(PrinterConnectionState.DISCONNECTED, outcome.error?.userMessage)
            try { transport.disconnect() } catch (_: Exception) { /* best effort */ }
            connectedPrinter = null
        } else {
            lastError = null
            setState(PrinterConnectionState.CONNECTED)
        }
        return outcome
    }

    fun testPrint(jobId: String, printerName: String? = null): PrintOutcome {
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date(clock()))
        return print(jobId, TsplEncoder.testLabel(printerName ?: connectedPrinter?.name ?: "PM-241-BT", stamp))
    }

    fun printQrLabel(jobId: String, spec: LabelSpec): PrintOutcome =
        print(jobId, spec.copy(barcodeValue = spec.barcodeValue ?: spec.containerCode))

    fun printBarcodeLabel(jobId: String, spec: LabelSpec): PrintOutcome =
        print(jobId, spec.copy(qrPayload = null))
}
