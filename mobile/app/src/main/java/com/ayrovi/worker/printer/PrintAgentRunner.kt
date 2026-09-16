package com.ayrovi.worker.printer

import com.ayrovi.worker.data.WorkerTransport
import com.ayrovi.worker.domain.AgentLabel
import com.ayrovi.worker.domain.PrintAgent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * PRINT AGENT RUNNER (owner order 2026-09-16, open item «PC → CT40 printer»).
 *
 * The missing half of the print path: a station display can print on the PC it
 * is plugged into (transport BROWSER), but a label queued for the OPERATOR'S
 * PRINTER has to leave through the app on the CT40 — a web page cannot reach a
 * Bluetooth SPP link.
 *
 * This runner lives beside the print bridge (same service, same lifecycle, same
 * already-paired printer) and, on a short interval, does exactly one thing per
 * label:
 *
 *   1. `GET  /v1/print-jobs/pending`   — labels queued for the worker's stations
 *   2. print it through [PrinterManager] (TSPL over the existing SPP link,
 *      duplicate-protected by the server's job id — a re-poll never re-prints,
 *      and never counts an already-printed label as new work either)
 *   3. `POST /v1/print-jobs/:id/result` — PRINTED or FAILED, so the audit trail
 *      says what physically happened (the same contract the browser uses)
 *
 * Safety rules it keeps:
 *  - no printer paired on this device → it does nothing at all (no error spam);
 *  - the link is serial: one label in flight, and a failed write stops the
 *    cycle instead of hammering a sick Bluetooth socket;
 *  - a lost report is not fatal: the job stays QUEUED and is offered again;
 *  - the server decides what a worker may see, so a stolen handheld cannot ask
 *    for another station's labels.
 */
class PrintAgentRunner(
    private val transport: WorkerTransport,
    private val printer: PrinterManager,
    private val persistence: PrinterPersistence,
    private val scope: CoroutineScope,
    private val agent: PrintAgent = PrintAgent(transport),
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
    private val onCycle: (printed: Int, error: String?) -> Unit = { _, _ -> },
) {

    companion object {
        /** Poll interval: long enough to be free, short enough to feel instant. */
        const val DEFAULT_INTERVAL_MS = 15_000L
    }

    private var loop: Job? = null

    @Volatile
    var lastCycleAtMs: Long? = null
        private set

    @Volatile
    var lastError: String? = null
        private set

    @Volatile
    var printedLabels: Int = 0
        private set

    val running: Boolean get() = loop?.isActive == true

    fun start() {
        if (loop?.isActive == true) return
        loop = scope.launch {
            while (isActive) {
                runCatching { tick() }
                delay(intervalMs)
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
    }

    /**
     * ONE cycle. Returns how many labels physically left the printer IN THIS
     * cycle — 0 when there is nothing to do, no printer is paired, the link is
     * down, or everything the server is offering is already on paper (the queue
     * keeps re-offering a job until the report lands, so a re-poll finding its
     * own previous output is the NORMAL case, not new work).
     */
    suspend fun tick(): Int {
        // No printer on this device → the agent is simply not for this CT40.
        val saved = persistence.loadSaved()
        if (saved == null) {
            lastError = null
            lastCycleAtMs = System.currentTimeMillis()
            onCycle(0, null)
            return 0
        }

        val jobs = try {
            agent.pending()
        } catch (e: Exception) {
            lastError = e.message ?: "The warehouse server could not be reached."
            lastCycleAtMs = System.currentTimeMillis()
            onCycle(0, lastError)
            return 0
        }
        if (jobs.isEmpty()) {
            lastError = null
            lastCycleAtMs = System.currentTimeMillis()
            onCycle(0, null)
            return 0
        }

        var printed = 0
        var failure: String? = null
        for (job in jobs) {
            if (!ensureConnected(saved)) {
                failure = printer.lastError?.code ?: "PRINTER_NOT_CONNECTED"
                break
            }
            // `copies` is printed as independent jobs ids so duplicate protection
            // stays per physical label (a lost link in the middle of a run of 3
            // must not silently drop the remaining two).
            val wanted = job.copies.coerceAtLeast(1)
            // `onPaper` = copies this handheld has handled (freshly printed now or
            // recognised as already printed by an earlier cycle); `fresh` = copies
            // that really moved paper right now. A duplicate means the previous
            // cycle printed it and only the report was lost — reporting PRINTED
            // again is exactly what closes that loop, but it is NOT new work and
            // must not be counted as such.
            var onPaper = 0
            var fresh = 0
            for (copy in 1..wanted) {
                val outcome = printer.print("${job.id}#$copy", job.label.toSpec())
                if (!outcome.ok) {
                    failure = outcome.error?.code ?: "PRINT_FAILED"
                    break
                }
                onPaper++
                if (!outcome.duplicate) fresh++
            }
            printed += fresh
            // The JOB is reported once (the server holds `copies`) and only after
            // the physical attempt: PRINTED means every requested copy left the
            // printer — a partial run is FAILED, never a half-true «printed».
            agent.report(job.id, printed = onPaper == wanted, error = failure)
            if (onPaper < wanted) break // link is sick → stop, next cycle retries
        }

        lastError = failure
        lastCycleAtMs = System.currentTimeMillis()
        printedLabels += printed
        onCycle(printed, failure)
        return printed
    }

    /** Reuse the paired printer; reconnect only when the link is genuinely gone. */
    private fun ensureConnected(saved: PrinterInfo): Boolean {
        if (printer.connectedPrinter?.address == saved.address) return true
        return printer.connect(saved.address, saved.name)
    }
}

/** The label as the TSPL encoder wants it — Design-A 60×40 mm stock. */
internal fun AgentLabel.toSpec(): LabelSpec = LabelSpec(
    title = title,
    lines = lines,
    barcodeValue = barcodeValue,
    widthMm = widthMm,
    heightMm = heightMm,
    gapMm = gapMm,
)
