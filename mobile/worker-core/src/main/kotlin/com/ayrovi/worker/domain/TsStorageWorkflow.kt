package com.ayrovi.worker.domain

import com.ayrovi.worker.data.TemporaryStorageGateway
import com.ayrovi.worker.data.TsHomePayload
import com.ayrovi.worker.data.TsSectionPayload
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

/**
 * TEMPORARY STORAGE station workflow (native worker app, CT40-first).
 *
 *   scan PRODUCT  -> backend resolves customer/section -> returns the TARGET
 *                    container (the UI highlights it)     (never typed by hand)
 *   scan CONTAINER -> backend final validation -> VALID / WRONG_CONTAINER /
 *                    FULL auto-advance / REVIEW / CARTON_NOT_ALLOWED
 *
 * The device renders server truth only; all state transitions below are the
 * mirror of the /v1/temporary-storage contracts (idempotent operationId per
 * physical scan pair). Cartons never enter this station.
 */
data class TsPendingUnit(
    val code: String,
    val operationId: String,
    val section: String,
    val customer: String,
    val surname: String? = null,
    val productLabel: String? = null,
    val targetCode: String,
    val targetCurrent: Int,
    val targetCapacity: Int,
    val mustCreate: Boolean = false,
    val remaining: Int = 0,
)

data class TsStorageState(
    val loaded: Boolean = false,
    val busy: Boolean = false,
    val authorized: Boolean = false,
    val serverAvailable: Boolean = false,
    val authExpired: Boolean = false,
    val home: TsHomePayload? = null,
    val letter: String? = null,
    val board: TsSectionPayload? = null,
    val pending: TsPendingUnit? = null,
    /** Scan that matches no confirmed product -> offered the Review lane. */
    val unknownCode: String? = null,
    val reviewHint: Boolean = false,
    val reportOpen: Boolean = false,
    val reportSent: Boolean = false,
    val message: OperationalMessage? = null,
    /** Container code to flash green after a successful store. */
    val flashOk: String? = null,
    /** Container code to flash red after a wrong scan. */
    val flashBad: String? = null,
    /** Bumped on scanner-relevant transitions to re-arm the capture host. */
    val scanEpoch: Int = 0,
) {
    val canScan: Boolean
        get() = loaded && !busy && authorized && serverAvailable && !authExpired
    val canMutate: Boolean
        get() = canScan
    /** Any section board currently shown (null -> station home). */
    val boardOpen: Boolean get() = letter != null
}

class TsStorageWorkflow(
    private val gateway: TemporaryStorageGateway,
    private val scope: CoroutineScope,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private var permissions: Set<String> = emptySet()
    private val mutable = MutableStateFlow(TsStorageState(authorized = false))
    val state = mutable.asStateFlow()

    private val messages = MutableSharedFlow<OperationalMessage>(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events = messages.asSharedFlow()

    fun updateAccess(granted: Set<String>, available: Boolean, authExpired: Boolean = false) {
        permissions = granted
        mutable.update { it.copy(authorized = requiredPermission in granted, serverAvailable = available, authExpired = authExpired) }
    }

    fun activate(granted: Set<String>, available: Boolean) {
        updateAccess(granted, available)
        refresh()
    }

    private fun emit(message: OperationalMessage, bumpScan: Boolean = false) {
        mutable.update { it.copy(message = message, scanEpoch = it.scanEpoch + if (bumpScan) 1 else 0) }
        messages.tryEmit(message)
    }

    private fun text(tone: MessageTone, title: String, detail: String, bumpScan: Boolean = false) =
        emit(OperationalMessage(title, detail, tone), bumpScan)

    private fun fail(failure: Throwable, fallback: String = "Ask your supervisor for help.") {
        text(MessageTone.ERROR, failure.toOperationalMessage().title, failure.toOperationalMessage().detail)
    }

    fun refresh() {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val home = gateway.tsHome()
                val letter = mutable.value.letter
                val board = if (letter != null) runCatching { gateway.tsSection(letter) }.getOrNull() else mutable.value.board
                mutable.update { it.copy(home = home, board = board, loaded = true, busy = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false, loaded = false) }
                fail(failure)
            }
        }
    }

    fun goHome() {
        mutable.update { it.copy(letter = null, board = null, pending = null, unknownCode = null, message = null, scanEpoch = it.scanEpoch + 1) }
        refresh()
    }

    fun openSection(letter: String) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true, letter = letter, pending = null, unknownCode = null, message = null, scanEpoch = it.scanEpoch + 1) }
        scope.launch {
            try {
                val board = gateway.tsSection(letter)
                val home = runCatching { gateway.tsHome() }.getOrNull()
                mutable.update { it.copy(board = board, home = home ?: it.home, loaded = true, busy = false) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false) }
                fail(failure)
            }
        }
    }

    fun clearPending() {
        mutable.update { it.copy(pending = null, message = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun dismissUnknown() {
        mutable.update { it.copy(unknownCode = null, message = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun clearFlash() {
        mutable.update { it.copy(flashOk = null, flashBad = null) }
    }

    /**
     * MASTER ORDER §27: a scan RESULT is acknowledged by the operator (BACK),
     * never by a timer. It disappears on BACK and is replaced by the next
     * hardware scan.
     */
    fun dismissResult() {
        mutable.update { it.copy(flashOk = null, flashBad = null, message = null) }
    }

    fun setReportOpen(open: Boolean) {
        mutable.update { it.copy(reportOpen = open) }
    }

    /** One physical scan: a product scan first, then the container of the pending unit. */
    fun scan(raw: String) {
        val value = raw.trim()
        if (value.isEmpty() || !mutable.value.canScan) return
        if (mutable.value.pending != null) scanContainer(value) else scanProduct(value)
    }

    private fun scanProduct(value: String) {
        mutable.update { it.copy(busy = true, message = null, scanEpoch = it.scanEpoch + 1) }
        scope.launch {
            try {
                val op = newId()
                val res = gateway.tsScanProduct(value, op)
                when (res.status) {
                    "VALID" -> {
                        val target = res.targetContainer
                        val product = res.product
                        if (target?.code == null || product?.section == null) {
                            text(MessageTone.ERROR, "NO TARGET CONTAINER", "The station could not resolve a target. Refresh and scan again.")
                            mutable.update { it.copy(busy = false) }
                            return@launch
                        }
                        val letter = product.section
                        val board = runCatching { gateway.tsSection(letter) }.getOrNull()
                        mutable.update {
                            it.copy(
                                home = it.home,
                                letter = letter,
                                board = board ?: it.board,
                                pending = TsPendingUnit(
                                    code = value,
                                    operationId = op,
                                    section = letter,
                                    customer = product.customer ?: "",
                                    surname = product.surname,
                                    productLabel = product.productName ?: product.reference ?: product.sku ?: value,
                                    targetCode = target.code,
                                    targetCurrent = target.current ?: 0,
                                    targetCapacity = target.capacity ?: 0,
                                    mustCreate = target.mustCreate == true,
                                    remaining = res.remaining ?: 0,
                                ),
                                unknownCode = null,
                                busy = false,
                                scanEpoch = it.scanEpoch + 1,
                            )
                        }
                        text(MessageTone.INFO, "SCAN CONTAINER ${target.code}", "Customer ${product.customer ?: "—"} · Section $letter · ${target.current}/${target.capacity}${if (target.mustCreate == true) " · NEW CONTAINER" else ""}", bumpScan = true)
                    }
                    "PRODUCT_NOT_FOUND" -> {
                        mutable.update { it.copy(unknownCode = value, busy = false, scanEpoch = it.scanEpoch + 1) }
                        text(MessageTone.WARNING, "NO CONFIRMED PRODUCT", "No confirmed unit matches this code. Send it to Review (admin alerted) or rescan.", bumpScan = true)
                    }
                    else -> {
                        mutable.update { it.copy(busy = false, scanEpoch = it.scanEpoch + 1) }
                        text(MessageTone.ERROR, res.status ?: "SCAN REJECTED", res.message ?: "This scan cannot be placed.", bumpScan = true)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false) }
                fail(failure)
            }
        }
    }

    private fun scanContainer(value: String) {
        val pending = mutable.value.pending ?: return
        mutable.update { it.copy(busy = true, message = null) }
        scope.launch {
            try {
                val res = gateway.tsPlace(pending.code, value, pending.operationId)
                when (res.status) {
                    "VALID" -> {
                        val placed = res.container
                        val flash = placed?.code ?: pending.targetCode
                        mutable.update {
                            it.copy(
                                pending = null,
                                flashOk = flash,
                                busy = false,
                                scanEpoch = it.scanEpoch + 1,
                            )
                        }
                        text(MessageTone.SUCCESS, "STORED → $flash", "Remaining: ${res.remaining ?: 0}", bumpScan = true)
                        if ((res.nextTarget) != null) {
                            text(MessageTone.INFO, "NEXT CONTAINER ${res.nextTarget.code} READY", "Container is FULL. Scan the product again to open ${res.nextTarget.code}.", bumpScan = true)
                        }
                        reloadQuietly()
                    }
                    "WRONG_CONTAINER" -> {
                        mutable.update {
                            it.copy(
                                flashBad = value,
                                busy = false,
                                pending = it.pending?.let { p ->
                                    val expected = res.expected?.containerCode
                                    if (expected != null && expected != p.targetCode) p.copy(targetCode = expected, mustCreate = true, targetCurrent = 0, targetCapacity = 0)
                                    else p
                                },
                                scanEpoch = it.scanEpoch + 1,
                            )
                        }
                        text(MessageTone.ERROR, "WRONG CONTAINER", (res.expected?.containerCode?.let { "Expected $it. " } ?: "") + (res.message ?: "Nothing was stored."), bumpScan = true)
                    }
                    "REVIEW", "ALREADY_IN_REVIEW" -> {
                        mutable.update { it.copy(pending = null, busy = false, scanEpoch = it.scanEpoch + 1) }
                        text(MessageTone.WARNING, "SENT TO REVIEW", "This product went to the Review lane and the admin was alerted.", bumpScan = true)
                        reloadQuietly()
                    }
                    "ALREADY_STORED", "AT_OTHER_STATION", "CARTON_NOT_ALLOWED" -> {
                        mutable.update { it.copy(pending = null, busy = false, scanEpoch = it.scanEpoch + 1) }
                        text(MessageTone.ERROR, res.status ?: "REJECTED", res.message ?: "This scan cannot be placed.")
                        reloadQuietly()
                    }
                    else -> {
                        mutable.update { it.copy(busy = false) }
                        text(MessageTone.ERROR, res.status ?: "PLACEMENT REJECTED", res.message ?: "Nothing was stored.")
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false) }
                fail(failure)
            }
        }
    }

    fun sendToReview() {
        val code = mutable.value.unknownCode ?: return
        if (!mutable.value.canScan) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val res = gateway.tsReview(code, "Product not recognised as a confirmed unit at Temporary Storage scan.", newId())
                when (res.status) {
                    "REVIEW", "ALREADY_IN_REVIEW" -> {
                        mutable.update { it.copy(unknownCode = null, busy = false, reviewHint = true, scanEpoch = it.scanEpoch + 1) }
                        text(MessageTone.WARNING, "→ REVIEW LANE · ADMIN ALERTED", res.review?.reason ?: "Exception opened.", bumpScan = true)
                        reloadQuietly()
                    }
                    else -> {
                        mutable.update { it.copy(busy = false) }
                        text(MessageTone.ERROR, "NOT SENT TO REVIEW", "Try again or rescan.")
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false) }
                fail(failure)
            }
        }
    }

    fun submitReport(observation: String?) {
        if (mutable.value.busy || mutable.value.reportSent) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                val res = gateway.tsReportFin(observation)
                mutable.update { it.copy(busy = false, reportSent = true, reportOpen = false) }
                text(MessageTone.SUCCESS, "RAPPORT DE FIN SUBMITTED", "Sent to Admin → Reports (station ${res.stationCode ?: "—"}).")
                reloadQuietly()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                mutable.update { it.copy(busy = false) }
                fail(failure)
            }
        }
    }

    private fun reloadQuietly() {
        scope.launch {
            val letter = mutable.value.letter
            val home = runCatching { gateway.tsHome() }.getOrNull()
            val board = if (letter != null) runCatching { gateway.tsSection(letter) }.getOrNull() else null
            mutable.update { it.copy(home = home ?: it.home, board = board ?: it.board) }
        }
    }

    companion object {
        val requiredPermission = "receiving.execute"
    }
}
