package com.ayrovi.worker.printer

import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * PRINT QUEUE (task §17/§18): exactly ONE job in flight on the single
 * Bluetooth link — jobs execute strictly sequentially on a single thread,
 * duplicate job IDs are short-circuited via persistence (never blindly
 * re-sent after an interrupted connection), and every job ends with exactly
 * one terminal callback.
 */
class PrintQueue(
    private val transport: PrinterTransport,
    private val persistence: PrinterPersistence,
    private val executor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ayrovi-print-queue").apply { isDaemon = true }
    },
) {

    /** Submit one job. Thread-safe: may be called from any thread. */
    fun submit(jobId: String, commands: ByteArray, onDone: (PrintOutcome) -> Unit) {
        // Duplicate protection FIRST (task §18): if the app already recorded
        // this job id as sent, the printer may already hold the label — do
        // not write again.
        if (persistence.seenJob(jobId)) {
            onDone(PrintOutcome(ok = true, duplicate = true))
            return
        }
        persistence.rememberJob(jobId)
        executor.execute {
            val outcome = try {
                transport.write(commands)
                PrintOutcome(ok = true, duplicate = false)
            } catch (e: PrinterException) {
                PrintOutcome(ok = false, duplicate = false, error = e.error)
            } catch (e: Exception) {
                PrintOutcome(
                    ok = false, duplicate = false,
                    error = PrinterError("PRINT_FAILED", "Printing failed. Check the printer.", e.message),
                )
            }
            onDone(outcome)
        }
    }

    /** Test helper / bridge sync point: waits until the queue drains. */
    fun awaitIdle(timeoutMs: Long = 15_000) {
        val done = java.util.concurrent.CountDownLatch(1)
        executor.execute { done.countDown() }
        done.await(timeoutMs, TimeUnit.MILLISECONDS)
    }
}
