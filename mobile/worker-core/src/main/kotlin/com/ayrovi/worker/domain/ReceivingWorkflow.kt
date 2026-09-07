package com.ayrovi.worker.domain

import com.ayrovi.worker.data.*
import com.ayrovi.worker.scanner.ScanResult
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Interaction steps of the card-based receiving terminal (no tote / no identification step). */
enum class ReceivingStep {
    ARRIVAL, PRODUCT, CARTON, REVIEW_PRODUCT, REVIEW_CARTON,
    REVIEW_COMPLETE, PAUSED, COMPLETE, RECONCILE,
}

enum class ReceivingMode { CARTONS, PRODUCTS }

/** Device-side MATCH preview for the PRODUIT lane (nothing confirmed until explicit CONFIRM). */
data class ProductReview(val scan: ScanResult, val card: ProductCard, val startedAt: Long)

/** Device-side MATCH preview for the CARTON lane (nothing confirmed until explicit CONFIRM). */
data class CartonReview(val scan: ScanResult, val card: CartonCard, val matchedOn: String, val startedAt: Long)

data class ReceivingState(
    val step: ReceivingStep = ReceivingStep.ARRIVAL,
    val mode: ReceivingMode = ReceivingMode.CARTONS,
    val busy: Boolean = false,
    val loaded: Boolean = false,
    val serverAvailable: Boolean = false,
    val authorized: Boolean = false,
    val canResolve: Boolean = false,
    val authExpired: Boolean = false,
    val storageBlocked: Boolean = false,
    val arrivals: List<ArrivalRow> = emptyList(),
    val session: ReceivingSession? = null,
    val product: ProductReview? = null,
    val carton: CartonReview? = null,
    val pending: PendingMutation? = null,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val lastScanValue: String? = null,
) {
    val canScan: Boolean get() = loaded && !storageBlocked && !busy && authorized && serverAvailable && pending == null && !authExpired &&
        step in setOf(ReceivingStep.ARRIVAL, ReceivingStep.PRODUCT, ReceivingStep.CARTON)
    val canMutate: Boolean get() = loaded && !storageBlocked && !busy && authorized && serverAvailable && pending == null && !authExpired
    val canSelectMode: Boolean get() = canMutate && (session == null || session.status == "RECEIVING")
    val canManageTask: Boolean get() = canMutate && session?.status == "RECEIVING"
    val canConfirm: Boolean get() = !busy && authorized && serverAvailable && !authExpired && !storageBlocked && pending == null &&
        ((step == ReceivingStep.REVIEW_PRODUCT && product != null) || (step == ReceivingStep.REVIEW_CARTON && carton != null))
    val hasVariance: Boolean get() = session?.tally?.let {
        it.openDiscrepancies > 0 || it.shortUnits > 0 || it.overageUnits > 0 || it.unexpectedProducts > 0 || it.missingCartons > 0
    } ?: true
    val canComplete: Boolean get() = canMutate && step == ReceivingStep.REVIEW_COMPLETE &&
        session?.status == "RECEIVING" && (!hasVariance || canResolve)
}

/**
 * Card-based receiving use case (device-side matching rebuild).
 *
 *   CRM ──▶ PRODUCT CARD / CARTON CARD (expected data, immutable)
 *        ──▶ session payload (productCards / cartonCards on the device)
 *        ──▶ [ PRODUIT ] lane: scan / OCR → CardMatcher → MATCH/MISMATCH → CONFIRM
 *        ──▶ [ CARTON ]  lane: scan → CardMatcher → MATCH/MISMATCH → CONFIRM
 *
 * Single-flight guard is set BEFORE scheduling a coroutine, so multiple fast
 * scans/taps cannot enqueue several writes. Every counter comes from the server.
 * The journal's marker id doubles as the backend idempotency key (operationId).
 */
class ReceivingWorkflow(
    private val gateway: ReceivingGateway,
    private val journal: MutationJournal,
    private val workerId: String,
    permissions: Set<String>,
    private val scope: CoroutineScope,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var permissions = permissions
    private val mutable = MutableStateFlow(ReceivingState(
        authorized = requiredPermissions.all { it in permissions },
        canResolve = WorkerAccess.RESOLVE_RECEIVING in permissions,
    ))
    val state = mutable.asStateFlow()
    private var signalId = 0L
    private val notifications = MutableSharedFlow<ReceivingSignal>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events = notifications.asSharedFlow()

    fun updateAccess(permissions: Set<String>, serverAvailable: Boolean) {
        this.permissions = permissions
        mutable.update { it.copy(
            authorized = requiredPermissions.all(permissions::contains),
            canResolve = WorkerAccess.RESOLVE_RECEIVING in permissions,
            serverAvailable = serverAvailable,
        ) }
    }

    fun initialize(recoverySessionId: String? = null) = run(readOnly = true, allowPending = true) {
        val pending = readJournal()
        mutable.update { it.copy(pending = pending) }
        if (pending != null) {
            reconcilePending(pending)
        } else {
            val arrivals = gateway.arrivals()
            mutable.update { it.copy(arrivals = arrivals, loaded = true, step = ReceivingStep.ARRIVAL) }
            if (recoverySessionId != null) adoptSession(gateway.receivingSession(recoverySessionId))
        }
    }

    /**
     * The two real workflow entries — PRODUIT and CARTON. Switching never
     * dispatches a stock write; it only re-arms the scanner for the lane.
     */
    fun selectMode(mode: ReceivingMode) {
        val before = mutable.value
        if (!before.canSelectMode || before.mode == mode) return
        run(readOnly = true) {
            val fresh = before.session?.let { gateway.receivingSession(it.id) }
            if (fresh != null && fresh.status != "RECEIVING") return@run adoptSession(fresh)
            mutable.update { it.copy(mode = mode, session = fresh ?: it.session, product = null, carton = null,
                lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
            if (fresh == null) {
                mutable.update { it.copy(message = OperationalMessage("LANE SELECTED",
                    "Scan the arrival before ${if (mode == ReceivingMode.CARTONS) "receiving cartons" else "receiving products"}.", MessageTone.INFO)) }
                return@run
            }
            val step = if (mode == ReceivingMode.CARTONS) ReceivingStep.CARTON else ReceivingStep.PRODUCT
            mutable.update { it.copy(step = step,
                message = OperationalMessage(
                    if (mode == ReceivingMode.CARTONS) "CARTON LANE" else "PRODUIT LANE",
                    if (mode == ReceivingMode.CARTONS)
                        "Scan a carton label — the carton card data is matched on this device."
                    else
                        "Scan a product QR/barcode or use OCR — the product card data is matched on this device.",
                    MessageTone.INFO)) }
        }
    }

    fun scan(result: ScanResult) {
        if (!mutable.value.canScan) return
        mutable.update { it.copy(lastScanValue = result.value) }
        when (mutable.value.step) {
            ReceivingStep.ARRIVAL -> openArrival(result.value, fromScanner = true)
            ReceivingStep.PRODUCT -> reviewProduct(result)
            ReceivingStep.CARTON -> reviewCarton(result)
            else -> Unit
        }
    }

    fun openArrival(code: String, fromScanner: Boolean = false) = run {
        if (mutable.value.step != ReceivingStep.ARRIVAL) return@run
        if (!fromScanner) mutable.update { it.copy(lastScanValue = null) }
        val key = code.trim()
        if (key.isEmpty()) return@run notice("SCAN AN ARRIVAL", "Use the AYROVI arrival code, not a customer or shipment label.")
        // ARRIVAL gate (receiving audit): a scanned value that is not an AYROVI
        // arrival code (WAR-…) is answered locally and never sent to the
        // arrival endpoint; queue selection and WAR- scans keep the backend path.
        if (fromScanner && !isArrivalScanCode(key)) {
            return@run notice(
                "NOT AN ARRIVAL CODE",
                "This is not an Arrival code. Select an Arrival from the queue or scan a WAR- code.",
                scanned = key,
                expected = "AYROVI arrival code",
            )
        }
        val active = gateway.activeSession(key)
        val session = active ?: mutate(MutationKind.START, arrivalCode = key) { gateway.startReceiving(key) }
        adoptSession(session)
        if (session.status == "RECEIVING") signal(MessageTone.SUCCESS, "ARRIVAL FOUND", "Continue with the next scan.", session.arrival.code ?: key)
    }

    /** Scannable arrival identity: the server-generated `WAR-…` display code. */
    private fun isArrivalScanCode(key: String): Boolean =
        key.length >= 4 && key.regionMatches(0, "WAR-", 0, 4, ignoreCase = true)

    // ---------- PRODUIT lane: device-side product card matching ----------
    private fun reviewProduct(scan: ScanResult) = run {
        val session = activeSession() ?: return@run
        val term = CardMatcher.normalize(scan.value)
        if (term.isEmpty()) return@run notice("EMPTY SCAN", "No code was read. Scan again.")
        val card = CardMatcher.matchProduct(session.productCards, term)
        when {
            card != null && card.received < card.expected -> {
                mutable.update { it.copy(step = ReceivingStep.REVIEW_PRODUCT, product = ProductReview(scan, card, clock()), carton = null,
                    message = OperationalMessage("MATCH FOUND", "Check the product, then confirm one physical unit.", MessageTone.INFO, scanned = term)) }
                signal(MessageTone.SUCCESS, "PRODUCT MATCH", card.productName ?: card.sku ?: term, card.sku ?: term)
            }
            card != null -> {
                mutable.update { it.copy(product = null, carton = null,
                    message = OperationalMessage("CARD ALREADY COMPLETE",
                        "${card.sku ?: term} is fully received. Nothing was counted again.", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "CARD ALREADY COMPLETE", "Nothing was counted again.", card.sku ?: term)
            }
            else -> reportDeviceMismatch(session, "PRODUCT", term, scan)
        }
    }

    // ---------- CARTON lane: device-side carton card matching ----------
    private fun reviewCarton(scan: ScanResult) = run {
        val session = activeSession() ?: return@run
        val term = CardMatcher.normalize(scan.value)
        if (term.isEmpty()) return@run notice("EMPTY SCAN", "No code was read. Scan again.")
        when (val verdict = CardMatcher.matchCarton(session.cartonCards, term)) {
            is CardMatcher.CartonVerdict.Card -> {
                mutable.update { it.copy(step = ReceivingStep.REVIEW_CARTON, carton = CartonReview(scan, verdict.card, verdict.matchedOn, clock()), product = null,
                    message = OperationalMessage("MATCH FOUND", "Check the carton, then confirm receipt.", MessageTone.INFO, scanned = term)) }
                signal(MessageTone.SUCCESS, "CARTON MATCH", "${verdict.card.externalCartonId ?: term} · ${verdict.matchedOn}", verdict.card.externalCartonId ?: term)
            }
            is CardMatcher.CartonVerdict.AllReceived -> {
                mutable.update { it.copy(product = null, carton = null,
                    message = OperationalMessage("CARTON ALREADY RECEIVED",
                        "${verdict.card.externalCartonId ?: term} was already received. It will not be counted again.", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "CARTON ALREADY RECEIVED", "Scan the next carton.", verdict.card.externalCartonId ?: term)
            }
            is CardMatcher.CartonVerdict.Ambiguous -> {
                val codes = verdict.candidates.joinToString(", ") { it.externalCartonId ?: "?" }
                mutable.update { it.copy(product = null, carton = null,
                    message = OperationalMessage("SEVERAL CARTONS MATCH",
                        "The tracking number matches ${verdict.candidates.size} cartons. Scan the specific carton: $codes", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "SEVERAL CARTONS MATCH", "Scan the specific carton: $codes", term)
            }
            CardMatcher.CartonVerdict.NotMatched -> reportDeviceMismatch(session, "CARTON", term, scan)
        }
    }

    /**
     * Device-side MISMATCH: nothing is confirmed and nothing completes. The
     * failure is logged on the backend (worker activity log + audit).
     */
    private suspend fun reportDeviceMismatch(session: ReceivingSession, cardType: String, term: String, scan: ScanResult) {
        mutate(MutationKind.REPORT_MISMATCH, subject = term) { operation ->
            gateway.reportMismatch(session.id, cardType, term, scan.scanType, scan.source.name, iso(clock())).also { response ->
                if (response.flash?.kind != "MISMATCH") throw ContractFailure("The backend did not confirm the mismatch log.")
            }
        }
        mutable.update { it.copy(product = null, carton = null,
            message = OperationalMessage("NOT MATCHED",
                if (cardType == "PRODUCT")
                    "No product card matches this code. The failure was logged."
                else
                    "No carton card matches this code. The failure was logged.",
                MessageTone.ERROR, scanned = term)) }
        signal(MessageTone.ERROR, "NOT MATCHED", "Logged. Check the label or ask your supervisor.", term)
    }

    /** Explicit operator confirm for the lane currently in review (MATCH → CONFIRM → backend). */
    fun confirmCard() = run {
        when (mutable.value.step) {
            ReceivingStep.REVIEW_PRODUCT -> confirmProductCard()
            ReceivingStep.REVIEW_CARTON -> confirmCartonCard()
            else -> Unit
        }
    }

    private suspend fun confirmProductCard() {
        val session = activeSession() ?: return
        val review = mutable.value.product ?: return
        val term = CardMatcher.normalize(review.scan.value)
        val result = mutate(MutationKind.CONFIRM_PRODUCT, subject = term) { operation ->
            gateway.confirmProduct(session.id, term, review.scan.scanType, 1, operation.id, review.scan.source.name, iso(review.startedAt)).also { response ->
                if (response.flash?.kind !in setOf("MATCH", "CARD_ALREADY_COMPLETE", "MISMATCH")) {
                    throw ContractFailure("The backend did not return a product verdict.")
                }
            }
        }
        applyVerdict(result, ReceivingStep.PRODUCT)
    }

    private suspend fun confirmCartonCard() {
        val session = activeSession() ?: return
        val review = mutable.value.carton ?: return
        val term = CardMatcher.normalize(review.scan.value)
        val result = mutate(MutationKind.CONFIRM_CARTON, subject = term) { operation ->
            gateway.confirmCarton(session.id, term, review.scan.scanType, operation.id, review.scan.source.name, iso(review.startedAt)).also { response ->
                if (response.flash?.kind !in setOf("MATCH", "CARD_ALREADY_COMPLETE", "TRACKING_AMBIGUOUS", "MISMATCH", "WRONG_SHIPMENT")) {
                    throw ContractFailure("The backend did not return a carton verdict.")
                }
            }
        }
        applyVerdict(result, ReceivingStep.CARTON)
    }

    /** Backend verdict → state + operator feedback. The server payload is the only source of counters. */
    private fun applyVerdict(result: ReceivingSession, lane: ReceivingStep) {
        if (result.status != "RECEIVING") return adoptSession(result)
        mutable.update { it.copy(session = result, product = null, carton = null, step = lane, scanEpoch = it.scanEpoch + 1) }
        when (result.flash?.kind) {
            "MATCH" -> signal(MessageTone.SUCCESS,
                if (lane == ReceivingStep.PRODUCT) "PRODUCT RECEIVED" else "CARTON RECEIVED",
                result.flash?.message ?: "Verified and recorded.", result.flash?.code)
            "CARD_ALREADY_COMPLETE" -> signal(MessageTone.WARNING, "CARD ALREADY COMPLETE", "Nothing was counted again.", result.flash?.code)
            "TRACKING_AMBIGUOUS" -> signal(MessageTone.WARNING, "SEVERAL CARTONS MATCH",
                result.flash?.message ?: "Scan the specific carton.", result.flash?.code)
            "WRONG_SHIPMENT" -> signal(MessageTone.ERROR, "WRONG SHIPMENT",
                result.flash?.message ?: "This carton belongs to another arrival.", result.flash?.code)
            else -> signal(MessageTone.ERROR, "NOT MATCHED",
                result.flash?.message ?: "The backend could not match this identifier.", result.flash?.code)
        }
    }

    /** Leave a review without submitting (never dispatches a write). */
    fun continueScanning() {
        if (!mutable.value.canMutate) return
        if (mutable.value.step !in setOf(ReceivingStep.REVIEW_PRODUCT, ReceivingStep.REVIEW_CARTON)) return
        val lane = if (mutable.value.step == ReceivingStep.REVIEW_PRODUCT) ReceivingStep.PRODUCT else ReceivingStep.CARTON
        mutable.update { it.copy(step = lane, product = null, carton = null, message = null, lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun pause() = run {
        val session = activeSession() ?: return@run
        adoptSession(mutate(MutationKind.PAUSE) { gateway.pauseSession(session.id) })
    }

    fun resume() = run {
        val session = mutable.value.session ?: return@run
        if (session.status != "PAUSED") return@run
        adoptSession(mutate(MutationKind.RESUME) { gateway.resumeSession(session.id) })
    }

    fun reviewCompletion() = run(readOnly = true) {
        val session = activeSession() ?: return@run
        val fresh = gateway.receivingSession(session.id)
        if (fresh.status != "RECEIVING") return@run adoptSession(fresh)
        mutable.update { it.copy(session = fresh, step = ReceivingStep.REVIEW_COMPLETE, product = null, carton = null) }
    }

    fun complete() = run {
        val before = mutable.value
        if (before.step != ReceivingStep.REVIEW_COMPLETE) return@run
        val session = activeSession() ?: return@run
        if (before.hasVariance && WorkerAccess.RESOLVE_RECEIVING !in permissions) {
            return@run notice("SUPERVISOR REQUIRED", "Receiving has discrepancies; a supervisor must close it.")
        }
        val complete = mutate(MutationKind.COMPLETE) { gateway.completeSession(session.id).also {
            if (it.status !in closedStatuses) throw ContractFailure("The session was not completed by the backend.")
        } }
        adoptSession(complete)
        signal(if (complete.status == "COMPLETED") MessageTone.SUCCESS else MessageTone.WARNING,
            if (complete.status == "CANCELLED") "TASK CANCELLED" else "RECEIVING COMPLETE", "Return to the work queue.", complete.code)
    }

    fun reportException(reason: String) = run {
        val session = activeSession() ?: return@run
        val trimmed = reason.trim()
        if (trimmed.isEmpty() || trimmed.length > 1_000) return@run notice("EXCEPTION REASON REQUIRED", "Enter a reason of 1 to 1,000 characters.")
        val result = mutate(MutationKind.FLAG, subject = trimmed) {
            gateway.flagSession(session.id, trimmed, mutable.value.product?.scan?.value, mutable.value.carton?.card?.externalCartonId)
        }
        updateSession(result)
        mutable.update { it.copy(message = OperationalMessage("EXCEPTION REPORTED",
            "Your problem was reported. Keep affected items aside for your supervisor.", MessageTone.WARNING)) }
    }

    fun resolveException(id: String, reason: String) = run {
        if (WorkerAccess.RESOLVE_RECEIVING !in permissions) return@run notice("ACTION NOT ALLOWED", "You cannot resolve receiving discrepancies.")
        if (reason.isBlank() || reason.length > 1_000) return@run notice("RESOLUTION REQUIRED", "Enter an actual resolution, not an empty approval.")
        if (mutable.value.session?.discrepancies?.none { it.id == id && it.status == "OPEN" } != false) return@run
        val result = mutate(MutationKind.RESOLVE, subject = id) { gateway.resolveDiscrepancy(id, reason.trim()) }
        updateSession(result)
        mutable.update { it.copy(message = OperationalMessage("EXCEPTION RESOLVED", reason.trim(), MessageTone.SUCCESS)) }
    }

    fun nextArrival() = run(readOnly = true) {
        if (mutable.value.session?.status !in closedStatuses) return@run
        val arrivals = gateway.arrivals()
        mutable.update { it.copy(step = ReceivingStep.ARRIVAL, session = null, product = null, carton = null,
            lastScanValue = null, arrivals = arrivals, scanEpoch = it.scanEpoch + 1) }
    }

    fun refresh() = run(readOnly = true, allowPending = true) {
        val pending = readJournal()
        if (pending != null) return@run reconcilePending(pending)
        val session = mutable.value.session
        if (session == null) {
            val arrivals = gateway.arrivals()
            mutable.update { it.copy(arrivals = arrivals, loaded = true, step = ReceivingStep.ARRIVAL) }
        } else {
            val fresh = gateway.receivingSession(session.id)
            if (fresh.status != "RECEIVING" || mutable.value.step in setOf(ReceivingStep.PAUSED, ReceivingStep.RECONCILE)) adoptSession(fresh)
            else mutable.update { it.copy(session = fresh) }
        }
    }

    private suspend fun reconcilePending(pending: PendingMutation) {
        mutable.update { it.copy(pending = pending, loaded = true, step = ReceivingStep.RECONCILE) }
        if (pending.workerId != workerId) {
            mutable.update { it.copy(session = null, message = OperationalMessage("DEVICE REQUIRES RECONCILIATION",
                "An operation from the previous worker is unresolved. Ask that worker and a supervisor to reconcile it before using this device.")) }
            return
        }
        val session = pending.sessionId?.let { gateway.receivingSession(it) }
            ?: pending.arrivalCode?.let { gateway.activeSession(it) }
        if (session == null) {
            notice("SESSION OUTCOME UNKNOWN", "Do not start another session yet. Ask a supervisor to verify this arrival.")
            return
        }
        mutable.update { it.copy(session = session) }
        val resolved = session.status in closedStatuses || when (pending.kind) {
            MutationKind.START -> true // A real active session was found; no second start is sent.
            MutationKind.PAUSE -> session.status == "PAUSED"
            MutationKind.RESUME -> session.status == "RECEIVING"
            MutationKind.RESOLVE -> session.discrepancies.any { it.id == pending.subject && it.status == "RESOLVED" }
            // Card confirmations / mismatch logs cannot be inferred from aggregate counters;
            // the backend idempotency key protects any later operator action.
            MutationKind.COMPLETE, MutationKind.CONFIRM_PRODUCT, MutationKind.CONFIRM_CARTON,
            MutationKind.REPORT_MISMATCH, MutationKind.FLAG -> false
        }
        if (resolved) {
            journal.clear(pending.id)
            mutable.update { it.copy(pending = null) }
            adoptSession(session)
            mutable.update { it.copy(message = OperationalMessage("TASK REOPENED",
                "Check your task before continuing.", MessageTone.INFO)) }
        } else {
            notice("OUTCOME NOT CONFIRMED",
                "The last operation outcome is not confirmed. Do not repeat it. Ask your supervisor to check the receipt before continuing.",
                pending.subject.takeUnless { pending.kind == MutationKind.FLAG })
        }
    }

    private fun adoptSession(session: ReceivingSession) {
        val step = when (session.status) {
            "RECEIVING" -> if (mutable.value.mode == ReceivingMode.CARTONS) ReceivingStep.CARTON else ReceivingStep.PRODUCT
            "PAUSED" -> ReceivingStep.PAUSED
            in closedStatuses -> ReceivingStep.COMPLETE
            else -> throw ContractFailure("Unknown receiving session state.")
        }
        mutable.update { it.copy(session = session, step = step, product = null, carton = null,
            lastScanValue = null, loaded = true, scanEpoch = it.scanEpoch + 1) }
    }

    private fun updateSession(session: ReceivingSession) {
        if (session.status == "RECEIVING") mutable.update { it.copy(session = session) }
        else adoptSession(session)
    }

    private fun activeSession(): ReceivingSession? {
        val session = mutable.value.session ?: return null
        if (session.status != "RECEIVING") {
            adoptSession(session)
            notice("SESSION NOT ACTIVE", "Resume a paused session before scanning. Closed sessions cannot accept work.")
            return null
        }
        return session
    }

    /** Only explicit API failures known to precede execution clear a failed mutation marker. */
    private suspend fun <T> mutate(
        kind: MutationKind,
        subject: String? = null,
        arrivalCode: String? = mutable.value.session?.arrival?.code,
        action: suspend (PendingMutation) -> T,
    ): T {
        val operation = PendingMutation(newId(), workerId, kind, mutable.value.session?.id, arrivalCode, subject, clock())
        try { journal.record(operation) } // durable before dispatch; failure prevents network request
        catch (failure: Exception) { mutable.update { it.copy(storageBlocked = true, step = ReceivingStep.RECONCILE) }; throw failure }
        mutable.update { it.copy(pending = operation) }
        try {
            val result = action(operation)
            journal.clear(operation.id)
            mutable.update { it.copy(pending = null) }
            return result
        } catch (failure: Exception) {
            val definiteRefusal = (failure is WorkerRepository.ApiException && !failure.outcomeUnknown) ||
                (failure is TransportFailure && !failure.outcomeUnknown) ||
                (failure is SessionChangedFailure && !failure.outcomeUnknown)
            if (definiteRefusal) {
                journal.clear(operation.id)
                mutable.update { it.copy(pending = null) }
            }
            throw failure
        }
    }

    @Synchronized
    private fun run(readOnly: Boolean = false, allowPending: Boolean = false, action: suspend () -> Unit) {
        val before = mutable.value
        if (before.busy || before.authExpired || (!allowPending && (before.pending != null || before.storageBlocked || !before.loaded))) return
        val permitted = if (readOnly) WorkerAccess.VIEW_RECEIVING in permissions else requiredPermissions.all(permissions::contains)
        if (!permitted) return notice("ACTION NOT ALLOWED", "Ask your supervisor to check your access.")
        if (!before.serverAvailable) return notice("CONNECTION UNAVAILABLE", "Check the connection before continuing.")
        mutable.update { it.copy(busy = true, message = null) }
        scope.launch {
            try {
                action()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (failure is WorkerRepository.ApiException && failure.code == 403) {
                    permissions = permissions - WorkerAccess.EXECUTE_RECEIVING
                    mutable.update { it.copy(authorized = false) }
                }
                val input = mutable.value.lastScanValue.takeIf { before.step in captureSteps || before.step in reviewSteps }
                val message = failure.toOperationalMessage().let {
                    if (input == null) it else it.copy(scanned = input, expected = when (before.step) {
                        ReceivingStep.ARRIVAL -> "AYROVI arrival code"
                        ReceivingStep.PRODUCT, ReceivingStep.REVIEW_PRODUCT -> "Product QR/barcode/OCR code"
                        else -> "Carton or tracking code"
                    })
                }
                mutable.update { it.copy(message = message, authExpired = (failure is WorkerRepository.ApiException && failure.code == 401) || failure is SessionChangedFailure) }
                signal(message.tone, message.title, message.detail, message.scanned)
            } finally {
                mutable.update { it.copy(busy = false, step = if (it.pending != null) ReceivingStep.RECONCILE else it.step) }
            }
        }
    }

    private fun readJournal(): PendingMutation? = try {
        journal.read().also { mutable.update { state -> state.copy(storageBlocked = false) } }
    } catch (failure: Exception) {
        mutable.update { it.copy(storageBlocked = true, step = ReceivingStep.RECONCILE) }
        throw failure
    }

    private fun notice(title: String, detail: String, scanned: String? = null, expected: String? = null) {
        val safe = WorkerMessages.reason(detail, "Check the label or ask your supervisor.")
        mutable.update { it.copy(message = OperationalMessage(title, safe, expected = expected, scanned = scanned)) }
        signal(MessageTone.ERROR, title, safe, scanned)
    }

    private fun iso(epochMillis: Long): String = java.time.Instant.ofEpochMilli(epochMillis).toString()

    @Synchronized private fun signal(tone: MessageTone, title: String, detail: String, code: String?) {
        notifications.tryEmit(ReceivingSignal(++signalId, tone, title, detail, code))
    }

    companion object {
        private val captureSteps = setOf(ReceivingStep.ARRIVAL, ReceivingStep.PRODUCT, ReceivingStep.CARTON)
        private val reviewSteps = setOf(ReceivingStep.REVIEW_PRODUCT, ReceivingStep.REVIEW_CARTON)
        private val requiredPermissions = setOf(WorkerAccess.VIEW_RECEIVING, WorkerAccess.EXECUTE_RECEIVING)
        private val closedStatuses = setOf("COMPLETED", "COMPLETED_WITH_DISCREPANCY", "CANCELLED")
    }
}
