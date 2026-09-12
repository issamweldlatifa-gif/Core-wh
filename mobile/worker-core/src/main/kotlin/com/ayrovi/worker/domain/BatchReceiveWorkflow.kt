package com.ayrovi.worker.domain

import com.ayrovi.worker.data.BatchCompleteReceivingIn
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.BatchRowPayload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class BatchReceiveState(
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val authorized: Boolean = false,
    val serverAvailable: Boolean = false,
    val authExpired: Boolean = false,
    /** Batches waiting to be received (new + resumable), newest first. */
    val queue: List<BatchRowPayload> = emptyList(),
    /** The batch currently being received. Null = picker/summary phase. */
    val batch: BatchRowPayload? = null,
    /** SERVER-truth progress (mirrors the last scan response). */
    val totalExpected: Int = 0,
    val totalScanned: Int = 0,
    /** Last scanned AYROVI unit code (for the verdict line). */
    val lastUnit: String? = null,
    /** Summary after completion (batch RECEIVING_COMPLETED). */
    val completed: BatchRowPayload? = null,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
) {
    val canScan: Boolean
        get() = authorized && serverAvailable && batch != null && !busy && completed == null
    val completeReady: Boolean
        get() = batch != null && totalExpected in 1..totalScanned
}

/**
 * BATCH RECEIVE workflow — the receiving side of Phase 2 (native worker app).
 *
 *   pick from the queue (admin SENT the batch)
 *   -> START (SENT_TO_RECEIVING -> RECEIVING_IN_PROGRESS)
 *   -> scan AYP labels: ONE scan = ONE unit; the SAME label twice is a
 *      server-confirmed no-op ("ALREADY RECEIVED"), never a double count.
 *      Progress is SERVER truth (each response carries scanned/expected).
 *   -> COMPLETE requires every unit (10/10) — server-enforced, the client
 *      only mirrors the gate to avoid a doomed call.
 *
 * NO DELETE: corrections are admin-side (VOID + reason, audited).
 * STATION NOTE (command check): the DISPATCH station is outbound-only;
 * batch receiving is inbound and rides the worker terminal 'batch' task —
 * no new station entity exists or is created here.
 */
class BatchReceiveWorkflow(
    private val gateway: BatchGateway,
    private val scope: CoroutineScope,
    private val newIdempotencyKey: () -> String = { UUID.randomUUID().toString() },
) {
    private val mutable = MutableStateFlow(BatchReceiveState())
    val state = mutable.asStateFlow()

    private val mutableEvents = MutableSharedFlow<OperationalMessage>(
        replay = 0, extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events = mutableEvents.asSharedFlow()

    private fun emit(message: OperationalMessage) {
        mutable.update { it.copy(message = message) }
        mutableEvents.tryEmit(message)
    }

    fun activate(authorized: Boolean, serverAvailable: Boolean) {
        mutable.update { it.copy(authorized = authorized, serverAvailable = serverAvailable) }
        if (authorized && serverAvailable) refresh()
    }

    /** Reload the queue. Never yanks an ACTIVE receiving session (§ stability). */
    fun refresh() {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val queue = gateway.batchReceiveQueue()
                mutable.update { it.copy(busy = false, loaded = true, queue = queue, authExpired = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The receiving queue could not be refreshed")
            }
        }
    }

    /** Open a batch for receiving (from the queue or a deep link target). */
    fun start(batchId: String) {
        if (mutable.value.busy) return
        // Synchronous claim — same double-fire guard as the build workflow.
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val res = gateway.batchStartReceiving(batchId)
                mutable.update {
                    it.copy(
                        busy = false,
                        batch = res.batch,
                        totalExpected = res.batch.totalExpected,
                        totalScanned = res.batch.totalScanned,
                        lastUnit = null, completed = null,
                        message = OperationalMessage(
                            "RECEIVING OPEN",
                            "${res.batch.batchCode} — scan every unit (${res.batch.totalExpected}).",
                            MessageTone.INFO,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The batch could not be opened for receiving")
            }
        }
    }

    /** ONE scan = ONE unit. Server truth drives the counters. */
    fun onScan(code: String) {
        val batch = mutable.value.batch ?: return
        if (mutable.value.busy || mutable.value.completed != null) return
        val unitCode = code.trim()
        if (unitCode.isEmpty()) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val res = gateway.batchReceiveUnit(batch.id, unitCode)
                mutable.update {
                    it.copy(
                        busy = false,
                        totalScanned = res.totalScanned,
                        totalExpected = res.totalExpected,
                        lastUnit = res.unitCode,
                        scanEpoch = it.scanEpoch + 1,
                        message = if (res.alreadyReceived) {
                            OperationalMessage("ALREADY RECEIVED", res.unitCode, MessageTone.WARNING)
                        } else {
                            OperationalMessage(
                                "UNIT RECEIVED", "${res.unitCode} · ${res.totalScanned}/${res.totalExpected}",
                                MessageTone.SUCCESS,
                            )
                        },
                    )
                }
                mutableEvents.tryEmit(
                    OperationalMessage(
                        if (res.alreadyReceived) "ALREADY RECEIVED" else "UNIT RECEIVED",
                        res.unitCode,
                        if (res.alreadyReceived) MessageTone.WARNING else MessageTone.SUCCESS,
                    ),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The unit was not received")
            }
        }
    }

    /** COMPLETE — client mirrors the 10/10 gate; the server re-enforces it. */
    fun complete() {
        val current = mutable.value
        val batch = current.batch ?: return
        if (current.busy || current.completed != null) return
        if (current.totalScanned < current.totalExpected) {
            val missing = (current.totalExpected - current.totalScanned).coerceAtLeast(0)
            emit(
                OperationalMessage(
                    "NOT COMPLETE", "$missing unit(s) still missing — scan everything first.",
                    MessageTone.WARNING,
                ),
            )
            return
        }
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val res = gateway.batchCompleteReceiving(batch.id, BatchCompleteReceivingIn(newIdempotencyKey()))
                mutable.update {
                    it.copy(
                        busy = false, completed = res.batch, batch = null,
                        lastUnit = null,
                        message = OperationalMessage(
                            "RECEIVING COMPLETED", "${res.batch.batchCode} — ${res.batch.totalExpected} unit(s).",
                            MessageTone.SUCCESS,
                        ),
                    )
                }
                mutableEvents.tryEmit(OperationalMessage("RECEIVING COMPLETED", res.batch.batchCode, MessageTone.SUCCESS))
                refresh()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "Receiving could not be completed")
            }
        }
    }

    /** Back from an ACTIVE session: the batch stays RECEIVING_IN_PROGRESS. */
    fun leaveActive() {
        mutable.update {
            it.copy(batch = null, totalScanned = 0, totalExpected = 0, lastUnit = null, message = null)
        }
        refresh()
    }

    /** Leave the completed summary (operational wipe of the local trace). */
    fun dismissSummary() {
        mutable.update { it.copy(completed = null, message = null) }
        refresh()
    }

    fun dismissResult() {
        mutable.update {
            val gone = it.message?.takeIf { m -> m.tone == MessageTone.INFO || m.tone == MessageTone.WARNING }
            it.copy(message = gone)
        }
    }

    private fun handleFailure(ex: Exception, what: String) {
        val auth = ex is com.ayrovi.worker.data.WorkerRepository.ApiException && ex.code == 401
        if (auth) {
            mutable.update { it.copy(busy = false, authExpired = true) }
            return
        }
        val offline = ex !is com.ayrovi.worker.data.WorkerRepository.ApiException
        emit(
            OperationalMessage(
                if (offline) "CONNECTION" else "NOT ACCEPTED",
                if (offline) "$what — check the connection and scan again." else WorkerMessages.reason(ex.message, what),
                MessageTone.ERROR,
            ),
        )
        mutable.update { it.copy(busy = false) }
    }
}
