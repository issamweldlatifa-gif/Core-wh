package com.ayrovi.worker.domain

import com.ayrovi.worker.data.BatchCreateIn
import com.ayrovi.worker.data.BatchCustomerIn
import com.ayrovi.worker.data.BatchGateway
import com.ayrovi.worker.data.BatchRowPayload
import com.ayrovi.worker.data.BatchSubmitIn
import com.ayrovi.worker.data.BatchUnitIn
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

/** One confirmed unit of the batch being built (AYP = server identity). */
data class BatchUnitRow(
    val ayp: String,
    val identifierType: String,
    /** Original identity VERBATIM — split by kind for the printed label. */
    val originalBarcode: String? = null,
    val originalSku: String? = null,
    val originalReference: String? = null,
    /** Per-add idempotency anchor — a retry of the SAME physical add reuses it. */
    val idempotencyKey: String = "",
) {
    val originalDisplay: String?
        get() = originalBarcode ?: originalSku ?: originalReference
}

data class BatchBuildState(
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val authorized: Boolean = false,
    val serverAvailable: Boolean = false,
    val authExpired: Boolean = false,
    /** The batch being built (CREATED). Null = picker/create phase. */
    val batch: BatchRowPayload? = null,
    val units: List<BatchUnitRow> = emptyList(),
    /** Resumable CREATED batches (server truth, newest first). */
    val open: List<BatchRowPayload> = emptyList(),
    /** Last AYP added — the label to print; flashes green on add. */
    val lastAdded: String? = null,
    val submittedDone: Boolean = false,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
) {
    val canScan: Boolean
        get() = authorized && serverAvailable && batch != null && !busy && !submittedDone
}

/**
 * Identifier classification for a scanned product code — PURE, tested.
 * The original identity is stored VERBATIM behind the matching label; the
 * server receives identifierType + identifierValue + the matching original.
 * Numeric codes are EAN/barcodes; anything else is treated as the SKU.
 */
fun identifierKindFor(code: String): Pair<String, String?> {
    val trimmed = code.trim()
    return if (trimmed.isNotEmpty() && trimmed.length >= 8 && trimmed.all { it.isDigit() }) {
        "BARCODE" to trimmed
    } else {
        "SKU" to trimmed
    }
}

/**
 * BATCH BUILD workflow (native worker app) — the worker-side of Phase 2:
 *
 *   create (customer typed IN the app, needsReview server-side)
 *   -> scan each piece  (ONE scan = ONE unit; AYP comes from the server;
 *      the same SKU on another physical piece is a NEW unit, never a dupe)
 *   -> print labels (AYP QR per unit — see BatchBarcodeRenderer/Print)
 *   -> submit (CREATED -> SUBMITTED; replay-safe idempotency key)
 *
 * Mirror of the /v1/batches contract. No delete exists: the worker simply
 * submits; corrections are admin-side (VOID + reason, audited).
 */
class BatchBuildWorkflow(
    private val gateway: BatchGateway,
    private val scope: CoroutineScope,
    private val newIdempotencyKey: () -> String = { UUID.randomUUID().toString() },
) {
    private val mutable = MutableStateFlow(BatchBuildState())
    val state = mutable.asStateFlow()

    private val mutableEvents = MutableSharedFlow<OperationalMessage>(
        replay = 0, extraBufferCapacity = 8, onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events = mutableEvents.asSharedFlow()

    private fun emit(message: OperationalMessage) {
        mutable.update { it.copy(message = message) }
        mutableEvents.tryEmit(message)
    }

    private fun note(message: OperationalMessage) {
        mutable.update { it.copy(message = message) }
    }

    fun activate(authorized: Boolean, serverAvailable: Boolean) {
        mutable.update { it.copy(authorized = authorized, serverAvailable = serverAvailable) }
        if (authorized && serverAvailable) refresh()
    }

    /** Reload the resumable list. Never yanks an ACTIVE build off the screen. */
    fun refresh() {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val open = gateway.batchOpen()
                mutable.update {
                    it.copy(busy = false, loaded = true, open = open, authExpired = false,
                        // An active build stays exactly as it is (§ stability).
                        batch = it.batch)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                val auth = ex is com.ayrovi.worker.data.WorkerRepository.ApiException && ex.code == 401
                mutable.update { it.copy(busy = false, loaded = true, authExpired = auth) }
                if (!auth) emit(OperationalMessage("CONNECTION", "Open batches could not be refreshed.", MessageTone.WARNING))
            }
        }
    }

    /** CREATE: the customer is created by the WORKER in the app. */
    fun create(customerName: String, externalRef: String? = null, firstScan: String? = null) {
        val name = customerName.trim()
        if (name.isEmpty()) {
            note(OperationalMessage("CUSTOMER REQUIRED", "Type the customer name to open a batch.", MessageTone.WARNING))
            return
        }
        if (mutable.value.busy) return
        // Synchronous claim: a double fire (two hardware reads in one event
        // burst) must never enqueue two operations.
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val first = firstScan?.let { unitInputFor(it, newIdempotencyKey()) }
                val res = gateway.batchCreate(
                    BatchCreateIn(
                        idempotencyKey = newIdempotencyKey(),
                        customer = BatchCustomerIn(name = name, externalRef = externalRef?.trim()?.ifEmpty { null }),
                        firstItem = first,
                    ),
                )
                val units = mutableListOf<BatchUnitRow>()
                res.first?.let { f ->
                    units += BatchUnitRow(
                        ayp = f.unit.code, identifierType = first!!.identifierType,
                        originalBarcode = first.originalBarcode, originalSku = first.originalSku,
                        originalReference = first.originalReference, idempotencyKey = first.idempotencyKey,
                    )
                }
                mutable.update {
                    it.copy(
                        busy = false, batch = res.batch, units = units, lastAdded = res.first?.unit?.code,
                        message = OperationalMessage(
                            "BATCH OPENED", "${res.batch.batchCode} — scan the products one by one.",
                            MessageTone.SUCCESS,
                        ),
                        submittedDone = false,
                    )
                }
                mutableEvents.tryEmit(OperationalMessage("BATCH OPENED", res.batch.batchCode, MessageTone.SUCCESS))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The batch could not be opened")
            }
        }
    }

    /** Resume one of this worker's CREATED batches (detail -> units). */
    fun continueBatch(batchId: String) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val detail = gateway.batchDetail(batchId)
                val units = detail.items.map {
                    BatchUnitRow(
                        ayp = it.unit.code, identifierType = it.identifierType,
                        originalBarcode = it.unit.originalBarcode, originalSku = it.unit.originalSku,
                        originalReference = it.unit.originalReference, idempotencyKey = it.id,
                    )
                }
                mutable.update {
                    it.copy(busy = false, batch = detail.toRow(), units = units, lastAdded = null, submittedDone = false)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The batch could not be reopened")
            }
        }
    }

    /** ONE scan = ONE unit. The AYROVI identity (AYP) comes from the server. */
    fun onScan(code: String) {
        val current = mutable.value
        if (current.batch == null || current.busy || current.submittedDone) return
        addUnit(code.trim())
    }

    /** MANUAL: an unreadable product — NO original value is ever invented. */
    fun addManual() {
        val current = mutable.value
        if (current.batch == null || current.busy || current.submittedDone) return
        addUnit(null)
    }

    private fun addUnit(rawCode: String?) {
        val batch = mutable.value.batch ?: return
        if (mutable.value.busy) return
        // Synchronous busy claim — the double-fire guard (see create()).
        mutable.update { it.copy(busy = true) }
        val key = newIdempotencyKey()
        val input = unitInputFor(rawCode, key)
        scope.launch {
            try {
                val res = gateway.batchAddUnit(batch.id, input)
                val row = BatchUnitRow(
                    ayp = res.unit.code, identifierType = input.identifierType,
                    originalBarcode = input.originalBarcode, originalSku = input.originalSku,
                    originalReference = input.originalReference, idempotencyKey = input.idempotencyKey,
                )
                mutable.update {
                    // Upsert by AYROVI code: a replay (lost response retry /
                    // same label seen twice) never duplicates a row, but a
                    // replay of a unit this device has not listed yet (added
                    // from another session) IS shown.
                    val units = if (it.units.any { u -> u.ayp == row.ayp }) it.units else it.units + row
                    it.copy(
                        busy = false, units = units, lastAdded = res.unit.code,
                        scanEpoch = it.scanEpoch + 1,
                        message = OperationalMessage(
                            if (res.replayed) "ALREADY IN THIS BATCH" else "UNIT ADDED",
                            "${res.unit.code}" + (rawCode?.let { c -> " · $c" } ?: " · MANUAL"),
                            if (res.replayed) MessageTone.WARNING else MessageTone.SUCCESS,
                        ),
                    )
                }
                mutableEvents.tryEmit(
                    OperationalMessage(
                        if (res.replayed) "ALREADY IN THIS BATCH" else "UNIT ADDED",
                        res.unit.code,
                        if (res.replayed) MessageTone.WARNING else MessageTone.SUCCESS,
                    ),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The unit was not added")
            }
        }
    }

    /** Submit the finished build. Replay-safe; the device wipes its local trace. */
    fun submit() {
        val current = mutable.value
        val batch = current.batch ?: return
        if (current.busy || current.submittedDone) return
        if (current.units.isEmpty()) {
            note(OperationalMessage("EMPTY BATCH", "Scan at least one unit before submitting.", MessageTone.WARNING))
            return
        }
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                gateway.batchSubmit(batch.id, BatchSubmitIn(idempotencyKey = newIdempotencyKey()))
                mutable.update {
                    it.copy(
                        busy = false, submittedDone = true, batch = null, units = emptyList(), lastAdded = null,
                        message = OperationalMessage("BATCH SUBMITTED", "${batch.batchCode} is waiting for admin acceptance.",
                            MessageTone.SUCCESS),
                    )
                }
                mutableEvents.tryEmit(OperationalMessage("BATCH SUBMITTED", batch.batchCode, MessageTone.SUCCESS))
                refresh()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (ex: Exception) {
                handleFailure(ex, "The batch was not submitted")
            }
        }
    }

    fun dismissResult() {
        mutable.update {
            val gone = it.message?.takeIf { m -> m.tone == MessageTone.INFO || m.tone == MessageTone.WARNING }
            it.copy(message = gone)
        }
    }

    fun leaveActive() {
        // Leaving an ACTIVE build keeps it on the server (still CREATED);
        // the worker resumes from the picker. Local unit rows are dropped.
        mutable.update { it.copy(batch = null, units = emptyList(), lastAdded = null, message = null) }
        refresh()
    }

    private fun unitInputFor(rawCode: String?, key: String): BatchUnitIn {
        if (rawCode == null) return BatchUnitIn(idempotencyKey = key, identifierType = "MANUAL")
        val (kind, original) = identifierKindFor(rawCode)
        return BatchUnitIn(
            idempotencyKey = key,
            identifierType = kind,
            identifierValue = rawCode,
            originalBarcode = if (kind == "BARCODE") original else null,
            originalSku = if (kind == "SKU") original else null,
        )
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
                scanned = null,
            ),
        )
        mutable.update { it.copy(busy = false) }
    }
}

private fun com.ayrovi.worker.data.BatchDetailPayload.toRow() = BatchRowPayload(
    id = id, batchCode = batchCode, status = status,
    totalExpected = totalExpected, totalScanned = totalScanned,
    createdAt = createdAt, customer = customer,
)
