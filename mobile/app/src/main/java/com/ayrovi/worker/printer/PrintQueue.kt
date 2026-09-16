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
 *
 * The claim in [submit] is the ONE thing that makes a print exactly-once, so
 * `seen? → remember` happens as a single atomic step (owner rule: one print
 * action = one physical label). The bridge answers requests on a thread pool
 * and the agent polls from its own coroutine, so two retries of the same job
 * really can be inside this method at the same instant: a check-then-act pair
 * let both of them find an unknown id and both write it — two labels for one
 * action. Duplicate protection must not depend on callers being polite.
 */
class PrintQueue(
    private val transport: PrinterTransport,
    private val persistence: PrinterPersistence,
    private val executor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ayrovi-print-queue").apply { isDaemon = true }
    },
) {

    /** Guards the claim below; also serializes every [PrinterPersistence] call. */
    private val claimLock = Any()

    /** Submit one job. Thread-safe: may be called from any thread. */
    fun submit(jobId: String, commands: ByteArray, onDone: (PrintOutcome) -> Unit) {
        // Duplicate protection FIRST and ATOMICALLY (task §18): if the app
        // already recorded this job id as sent, the printer may already hold
        // the label — do not write again.
        val claimed = synchronized(claimLock) {
            if (persistence.seenJob(jobId)) {
                false
            } else {
                persistence.rememberJob(jobId)
                true
            }
        }
        if (!claimed) {
            onDone(PrintOutcome(ok = true, duplicate = true))
            return
        }
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
