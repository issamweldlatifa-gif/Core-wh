package com.ayrovi.worker.domain

import com.ayrovi.worker.data.*
import com.ayrovi.worker.scanner.ScanResult
import com.ayrovi.worker.scanner.ScanSource
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Interaction steps, not a second implementation of backend stock transitions. */
enum class ReceivingStep {
    ARRIVAL, CARTON, CONFIRM_CARTON, TOTE, PRODUCT, REVIEW_PRODUCT,
    RESULT, REVIEW_COMPLETE, PAUSED, COMPLETE, RECONCILE,
}

enum class ReceivingMode { CARTONS, PRODUCTS }

data class IdentifiedCarton(val id: String, val code: String, val source: ScanSource, val alreadyReceived: Boolean = false)
data class ProductReview(val scan: ScanResult, val product: ProductRow?, val quantity: String = "1")

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
    val carton: IdentifiedCarton? = null, // preview, NOT stock receipt evidence
    val sourceCarton: IdentifiedCarton? = null, // assigned only after a server RECEIVED event
    val tote: OpContainerDetail? = null,
    val product: ProductReview? = null,
    val receipt: ConfirmedReceipt? = null,
    val restoredReceipt: Boolean = false,
    val pending: PendingMutation? = null,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val lastScanValue: String? = null,
) {
    val canScan: Boolean get() = loaded && !storageBlocked && !busy && authorized && serverAvailable && pending == null && !authExpired &&
        step in setOf(ReceivingStep.ARRIVAL, ReceivingStep.CARTON, ReceivingStep.TOTE, ReceivingStep.PRODUCT)
    val canMutate: Boolean get() = loaded && !storageBlocked && !busy && authorized && serverAvailable && pending == null && !authExpired
    val canSelectMode: Boolean get() = canMutate && (session == null || session.status == "RECEIVING")
    val canManageTask: Boolean get() = canMutate && session?.status == "RECEIVING"
    val hasVariance: Boolean get() = session?.tally?.let {
        it.openDiscrepancies > 0 || it.shortUnits > 0 || it.overageUnits > 0 || it.unexpectedProducts > 0 || it.missingCartons > 0
    } ?: true
    val canAcknowledgeReceipt: Boolean get() = !busy && authorized && serverAvailable && !authExpired &&
        !storageBlocked && step == ReceivingStep.RESULT && pending?.confirmedReceipt != null
    val canComplete: Boolean get() = canMutate && step == ReceivingStep.REVIEW_COMPLETE &&
        session?.status == "RECEIVING" && (!hasVariance || canResolve)
}

/**
 * Receiving-first use case. Single-flight guard is set BEFORE scheduling a coroutine, so
 * multiple fast scans/taps cannot enqueue several writes. Every counter comes from the server.
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

    /** One-tap intent, not a second workflow. Switching does not dispatch any stock POST. */
    fun selectMode(mode: ReceivingMode) {
        val before = mutable.value
        if (!before.canSelectMode || before.mode == mode) return
        run(readOnly = true) {
            val fresh = before.session?.let { gateway.receivingSession(it.id) }
            if (fresh != null && fresh.status != "RECEIVING") return@run adoptSession(fresh)
            mutable.update { it.copy(mode = mode, session = fresh ?: it.session, product = null, receipt = null,
                lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
            when {
                fresh == null -> mutable.update { it.copy(message = OperationalMessage("MODE SELECTED",
                    "Scan the arrival before ${if (mode == ReceivingMode.CARTONS) "receiving cartons" else "receiving products"}.", MessageTone.INFO)) }
                before.step == ReceivingStep.CONFIRM_CARTON && before.carton != null -> {
                    // Do not silently substitute the previous source for the carton just identified.
                    mutable.update { it.copy(message = OperationalMessage("CONFIRM THE IDENTIFIED CARTON",
                        "${before.carton.code} is only identified. Confirm it before continuing in the selected mode.", MessageTone.INFO)) }
                }
                mode == ReceivingMode.CARTONS -> mutable.update { it.copy(step = ReceivingStep.CARTON, carton = null,
                    message = OperationalMessage("CARTON MODE", "Scan a carton, verify it, then confirm receipt. No product was received.", MessageTone.INFO)) }
                else -> enterProductLane(fresh, before.tote)
            }
        }
    }

    fun scan(result: ScanResult) {
        if (!mutable.value.canScan) return
        mutable.update { it.copy(lastScanValue = result.value) }
        when (mutable.value.step) {
            ReceivingStep.ARRIVAL -> openArrival(result.value, fromScanner = true)
            ReceivingStep.CARTON -> identifyCarton(result)
            ReceivingStep.TOTE -> selectTote(result.value)
            ReceivingStep.PRODUCT -> reviewProduct(result)
            else -> Unit
        }
    }

    fun openArrival(code: String, fromScanner: Boolean = false) = run {
        if (mutable.value.step != ReceivingStep.ARRIVAL) return@run
        if (!fromScanner) mutable.update { it.copy(lastScanValue = null) }
        val key = code.trim()
        if (key.isEmpty()) return@run notice("SCAN AN ARRIVAL", "Use the AYROVI arrival code, not a customer or shipment label.")
        val active = gateway.activeSession(key)
        val session = active ?: mutate(MutationKind.START, arrivalCode = key) { gateway.startReceiving(key) }
        adoptSession(session)
        if (session.status == "RECEIVING") signal(MessageTone.SUCCESS, "ARRIVAL FOUND", "Continue with the next scan.", session.arrival.code ?: key)
    }

    private fun identifyCarton(scan: ScanResult) = run {
        val session = activeSession() ?: return@run
        // A newly presented carton supersedes the physical source intent, even when invalid.
        // Never let switching to Produit silently fall back to an older confirmed carton.
        mutable.update { it.copy(sourceCarton = null, carton = null) }
        val result = mutate(MutationKind.IDENTIFY_CARTON, subject = scan.value) { operation ->
            gateway.scanCarton(session.id, scan.value, scan.scanType, operation.id, scan.source.name)
        }
        if (result.status != "RECEIVING") return@run adoptSession(result)
        mutable.update { it.copy(session = result, carton = null, product = null) }
        val flash = result.flash
        when (flash?.kind) {
            "CARTON_IDENTIFIED" -> {
                val id = flash.carton.field("id") ?: throw ContractFailure("Identified carton has no id.")
                val code = flash.carton.field("externalCartonId") ?: throw ContractFailure("Identified carton has no code.")
                mutable.update { it.copy(step = ReceivingStep.CONFIRM_CARTON,
                    carton = IdentifiedCarton(id, code, scan.source),
                    message = OperationalMessage("CARTON IDENTIFIED", "Check the carton, then confirm receipt.", MessageTone.INFO)) }
                signal(MessageTone.SUCCESS, "CARTON FOUND", "Confirm this carton.", code)
            }
            "DUPLICATE_CARTON" -> {
                val code = (flash.carton as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                if (code != null && result.receivedCartonEvents.any { it.cartonId == code && it.status == "RECEIVED" }) {
                    if (mutable.value.mode == ReceivingMode.CARTONS) {
                        mutable.update { it.copy(step = ReceivingStep.CARTON, carton = null,
                            message = OperationalMessage("ALREADY RECEIVED", "Scan the next carton.")) }
                        signal(MessageTone.ERROR, "ALREADY RECEIVED", "Scan the next carton.", code)
                    } else {
                        mutable.update { it.copy(step = ReceivingStep.CONFIRM_CARTON,
                            carton = IdentifiedCarton(code, code, scan.source, alreadyReceived = true),
                            message = OperationalMessage("CARTON ALREADY RECEIVED", "Confirm it as your source carton. It will not be counted again.", MessageTone.WARNING)) }
                        signal(MessageTone.ERROR, "ALREADY RECEIVED", "Confirm it only if this is your source carton.", code)
                    }
                } else notice("DUPLICATE CARTON", "This carton has already been received. Check the session with a supervisor.", scan.value)
            }
            "UNKNOWN_CARTON" -> notice("CARTON NOT FOUND", reason(result, "Unknown carton scan: ${scan.value}"), scan.value)
            "WRONG_SHIPMENT" -> notice("WRONG SHIPMENT", reason(result, "This carton belongs to another shipment."), scan.value, session.arrival.code)
            else -> notice("CARTON NOT ACCEPTED", "Unable to identify this carton. Check the label and try again.", scan.value)
        }
    }

    fun confirmCarton() = run {
        if (mutable.value.step != ReceivingStep.CONFIRM_CARTON) return@run
        val session = activeSession() ?: return@run
        val carton = mutable.value.carton ?: return@run
        if (!carton.alreadyReceived) {
            val received = mutate(MutationKind.RECEIVE_CARTON, subject = carton.code) { operation ->
                gateway.receiveCarton(session.id, carton.id, operation.id, carton.source.name).also { response ->
                    if (response.receivedCartonEvents.none { it.cartonId == carton.code && it.status == "RECEIVED" }) {
                        throw ContractFailure("The backend has not confirmed a received carton event.")
                    }
                }
            }
            if (received.status != "RECEIVING") return@run adoptSession(received)
            mutable.update { it.copy(session = received) }
        }
        mutable.update { it.copy(sourceCarton = carton.copy(alreadyReceived = true), carton = null,
            product = null, receipt = null, scanEpoch = it.scanEpoch + 1) }
        if (mutable.value.mode == ReceivingMode.CARTONS) {
            mutable.update { it.copy(step = ReceivingStep.CARTON,
                message = OperationalMessage(if (carton.alreadyReceived) "ALREADY RECEIVED · NOT COUNTED AGAIN" else "CARTON RECEIVED",
                    "${carton.code} · Scan the next carton, or choose Produit.", if (carton.alreadyReceived) MessageTone.WARNING else MessageTone.SUCCESS)) }
        } else enterProductLane(mutable.value.session!!, mutable.value.tote)
        signal(MessageTone.SUCCESS, if (carton.alreadyReceived) "SOURCE CONFIRMED" else "CARTON RECEIVED", "Continue with the next item.", carton.code)
    }

    private fun hasConfirmedSource(session: ReceivingSession): Boolean {
        val source = mutable.value.sourceCarton
        return session.tally.expectedCartons == 0 || (source != null && session.receivedCartonEvents.any {
            it.cartonId == source.code && it.status == "RECEIVED"
        })
    }

    private suspend fun enterProductLane(session: ReceivingSession, reuseTote: OpContainerDetail?, verifyTote: Boolean = true) {
        mutable.update { it.copy(session = session, carton = null, product = null, receipt = null, restoredReceipt = false) }
        if (!hasConfirmedSource(session)) {
            mutable.update { it.copy(step = ReceivingStep.CARTON, sourceCarton = null,
                message = OperationalMessage("PRODUCT MODE · SOURCE REQUIRED",
                    "Scan and confirm the source carton first.", MessageTone.INFO)) }
            return
        }
        mutable.update { it.copy(step = ReceivingStep.TOTE, tote = null,
            message = OperationalMessage("PRODUCT MODE", "Scan an open receiving tote.", MessageTone.INFO)) }
        if (reuseTote != null) {
            val checked = if (verifyTote) gateway.container(reuseTote.code) else reuseTote
            if (checked.type != "RECEIVING" || checked.status != "ACTIVE") {
                notice("TOTE CANNOT BE USED", "This tote is closed or cannot receive products. Scan another tote.", checked.code, "Open receiving tote")
                return
            }
            mutable.update { it.copy(step = ReceivingStep.PRODUCT, tote = checked,
                message = OperationalMessage("PRODUCT MODE", "Source and tote verified. Scan the next product into ${checked.code}.", MessageTone.INFO)) }
        }
    }

    private fun selectTote(code: String) = run(readOnly = true) {
        if (mutable.value.mode != ReceivingMode.PRODUCTS) return@run
        activeSession() ?: return@run
        val tote = gateway.container(code)
        if (tote.type != "RECEIVING" || tote.status != "ACTIVE") {
            return@run notice("TOTE CANNOT BE USED", "This tote is closed or cannot receive products. Scan another tote.", code, "Open receiving tote")
        }
        mutable.update { it.copy(tote = tote, step = ReceivingStep.PRODUCT, product = null,
            message = OperationalMessage("TOTE VERIFIED", "Place each confirmed article into ${tote.code}.", MessageTone.INFO)) }
        signal(MessageTone.SUCCESS, "TOTE FOUND", "Scan the product.", tote.code)
    }

    private fun reviewProduct(scan: ScanResult) = run(readOnly = true) {
        if (mutable.value.mode != ReceivingMode.PRODUCTS) return@run
        val session = activeSession() ?: return@run
        val fresh = gateway.receivingSession(session.id)
        if (fresh.status != "RECEIVING") return@run adoptSession(fresh)
        if (!hasConfirmedSource(fresh)) return@run enterProductLane(fresh, mutable.value.tote)
        // Review-only lookup using the server's exact SKU. Backend still validates the receipt.
        val row = fresh.products.singleOrNull { it.sku == scan.value }
        mutable.update { it.copy(session = fresh, product = ProductReview(scan, row), step = ReceivingStep.REVIEW_PRODUCT,
            message = if (row == null || row.expected == 0)
                OperationalMessage("PRODUCT NOT EXPECTED", "Confirming will record one physical article and a receiving exception. This is not a rejection.", MessageTone.WARNING, scanned = scan.value)
            else OperationalMessage("PRODUCT IDENTIFIED", "Check the product and confirm one physical unit into the tote.", MessageTone.INFO)) }
        signal(if (row == null || row.expected == 0) MessageTone.WARNING else MessageTone.SUCCESS,
            if (row == null || row.expected == 0) "PRODUCT NOT EXPECTED" else "PRODUCT FOUND",
            "Check the product and quantity.", scan.value)
    }

    fun setQuantity(raw: String) {
        if (mutable.value.busy || mutable.value.step != ReceivingStep.REVIEW_PRODUCT) return
        mutable.update { it.copy(product = it.product?.copy(quantity = raw.take(32))) }
    }

    fun confirmProduct() = run {
        if (mutable.value.step != ReceivingStep.REVIEW_PRODUCT || mutable.value.mode != ReceivingMode.PRODUCTS) return@run
        val session = activeSession() ?: return@run
        val product = mutable.value.product ?: return@run
        if (!hasConfirmedSource(session)) return@run notice("SOURCE CARTON REQUIRED", "Identify and confirm the physical source carton before receiving an article.")
        val tote = mutable.value.tote ?: return@run
        val quantity = product.quantity.toIntOrNull()
        if (quantity == null || quantity <= 0) return@run notice("ENTER A VALID QUANTITY", "Use a positive whole number. No receipt was submitted.")
        if (quantity != 1) return@run notice("RECEIVE ONE UNIT", "Receive one physical unit at a time.")
        mutate(MutationKind.RECEIVE_ARTICLE, subject = product.scan.value, containerCode = tote.code,
            receiptEvidence = { result: ArticleScanResult -> ConfirmedReceipt(
                result.flash?.article.field("code")!!, product.scan.value, tote.code,
                result.flash?.kind == "UNEXPECTED_ARTICLE" || !result.matched,
            ) },
        ) {
            gateway.scanArticleAtReceiving(session.id, product.scan.value, tote.code, mutable.value.sourceCarton?.code).also { result ->
                if (result.flash?.kind !in setOf("ARTICLE_RECEIVED", "UNEXPECTED_ARTICLE") || result.flash?.article.field("code").isNullOrBlank()) {
                    throw ContractFailure("The backend did not confirm an article identity.")
                }
            }
        }
        val receipt = checkNotNull(mutable.value.pending?.confirmedReceipt)
        mutable.update { it.copy(step = ReceivingStep.RESULT, restoredReceipt = false, receipt = receipt,
            message = OperationalMessage(if (receipt.withException) "RECEIVED WITH EXCEPTION" else "ARTICLE RECEIVED",
                "${receipt.articleCode} → ${receipt.toteCode}", if (receipt.withException) MessageTone.WARNING else MessageTone.SUCCESS)) }
        signal(if (receipt.withException) MessageTone.WARNING else MessageTone.SUCCESS,
            if (receipt.withException) "RECEIVED WITH EXCEPTION" else "ARTICLE RECEIVED", "Place the unit in its tote.", receipt.articleCode)
        // A later read failure does not turn the already confirmed write into an unconfirmed receipt.
        val fresh = gateway.receivingSession(session.id)
        mutable.update { it.copy(session = fresh) }
    }

    fun nextProduct() = run(readOnly = true, allowPending = true) {
        val pending = mutable.value.pending
        if (pending != null && pending.confirmedReceipt == null) return@run
        if (mutable.value.storageBlocked) return@run
        if (mutable.value.step !in setOf(ReceivingStep.RESULT, ReceivingStep.REVIEW_PRODUCT, ReceivingStep.REVIEW_COMPLETE)) return@run
        val session = mutable.value.session ?: return@run
        val fresh = gateway.receivingSession(session.id)
        // This explicit operator action acknowledges the PREVIOUS recorded unit. No POST/replay.
        if (pending != null) { journal.clear(pending.id); mutable.update { it.copy(pending = null) } }
        if (fresh.status != "RECEIVING") return@run adoptSession(fresh)
        mutable.update { it.copy(scanEpoch = it.scanEpoch + 1) }
        if (mutable.value.mode == ReceivingMode.CARTONS) {
            mutable.update { it.copy(session = fresh, step = ReceivingStep.CARTON, carton = null, product = null, receipt = null) }
        } else enterProductLane(fresh, mutable.value.tote, verifyTote = false)
    }

    fun changeCarton() {
        if (!mutable.value.canMutate || mutable.value.session?.status != "RECEIVING") return
        mutable.update { it.copy(step = ReceivingStep.CARTON, carton = null, sourceCarton = null, product = null, receipt = null, message = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun changeTote() {
        if (!mutable.value.canMutate || mutable.value.session?.status != "RECEIVING") return
        if (mutable.value.mode != ReceivingMode.PRODUCTS || !hasConfirmedSource(mutable.value.session!!)) return
        mutable.update { it.copy(step = ReceivingStep.TOTE, tote = null, product = null, receipt = null, message = null, scanEpoch = it.scanEpoch + 1) }
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
        mutable.update { it.copy(session = fresh, step = ReceivingStep.REVIEW_COMPLETE, product = null, receipt = null) }
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
            gateway.flagSession(session.id, trimmed, mutable.value.product?.scan?.value, mutable.value.carton?.code ?: mutable.value.sourceCarton?.code)
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
        mutable.update { it.copy(step = ReceivingStep.ARRIVAL, session = null, carton = null, sourceCarton = null, tote = null,
            product = null, receipt = null, lastScanValue = null, arrivals = arrivals, scanEpoch = it.scanEpoch + 1) }
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
        pending.confirmedReceipt?.let { receipt ->
            mutable.update { it.copy(mode = ReceivingMode.PRODUCTS, step = ReceivingStep.RESULT, receipt = receipt, restoredReceipt = true,
                message = OperationalMessage("PREVIOUS UNIT WAS RECORDED",
                    "${receipt.articleCode} → ${receipt.toteCode}. Do not receive this unit again. Verify physical placement, then acknowledge it.", MessageTone.WARNING)) }
            return
        }
        val resolved = session.status in closedStatuses || when (pending.kind) {
            MutationKind.START -> true // A real active session was found; no second start is sent.
            MutationKind.IDENTIFY_CARTON -> true // Identification never commits physical stock; reload shows any exception.
            MutationKind.RECEIVE_CARTON -> session.receivedCartonEvents.any { it.cartonId == pending.subject && it.status == "RECEIVED" }
            MutationKind.PAUSE -> session.status == "PAUSED"
            MutationKind.RESUME -> session.status == "RECEIVING"
            MutationKind.RESOLVE -> session.discrepancies.any { it.id == pending.subject && it.status == "RESOLVED" }
            MutationKind.COMPLETE, MutationKind.RECEIVE_ARTICLE, MutationKind.FLAG -> false
        }
        if (resolved) {
            journal.clear(pending.id)
            mutable.update { it.copy(pending = null) }
            adoptSession(session)
            mutable.update { it.copy(message = OperationalMessage("TASK REOPENED",
                "Check your task before continuing.", MessageTone.INFO)) }
        } else {
            notice("OUTCOME NOT CONFIRMED",
                "Do not receive this item again. Ask your supervisor to check the receipt before continuing.", pending.subject.takeUnless { pending.kind == MutationKind.FLAG })
        }
    }

    private fun adoptSession(session: ReceivingSession) {
        val step = when (session.status) {
            "RECEIVING" -> if (mutable.value.mode == ReceivingMode.CARTONS || session.tally.expectedCartons > 0) ReceivingStep.CARTON else ReceivingStep.TOTE
            "PAUSED" -> ReceivingStep.PAUSED
            in closedStatuses -> ReceivingStep.COMPLETE
            else -> throw ContractFailure("Unknown receiving session state.")
        }
        mutable.update { it.copy(session = session, step = step, carton = null, sourceCarton = null, tote = null,
            product = null, receipt = null, restoredReceipt = false, lastScanValue = null, loaded = true, scanEpoch = it.scanEpoch + 1) }
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
        containerCode: String? = null,
        receiptEvidence: ((T) -> ConfirmedReceipt)? = null,
        action: suspend (PendingMutation) -> T,
    ): T {
        val operation = PendingMutation(newId(), workerId, kind, mutable.value.session?.id, arrivalCode, subject, containerCode, clock())
        try { journal.record(operation) } // durable before dispatch; failure prevents network request
        catch (failure: Exception) { mutable.update { it.copy(storageBlocked = true, step = ReceivingStep.RECONCILE) }; throw failure }
        mutable.update { it.copy(pending = operation) }
        try {
            val result = action(operation)
            val receipt = receiptEvidence?.invoke(result)
            if (receipt != null) {
                val confirmed = operation.copy(confirmedReceipt = receipt)
                journal.record(confirmed) // Durable evidence BEFORE publishing a successful receipt.
                mutable.update { it.copy(pending = confirmed) }
            } else {
                journal.clear(operation.id)
                mutable.update { it.copy(pending = null) }
            }
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
                val input = mutable.value.lastScanValue.takeIf { before.step in captureSteps || before.step == ReceivingStep.REVIEW_PRODUCT }
                val message = failure.toOperationalMessage().let {
                    if (input == null) it else it.copy(scanned = input, expected = when (before.step) {
                        ReceivingStep.ARRIVAL -> "AYROVI arrival code"
                        ReceivingStep.TOTE -> "Open receiving tote"
                        ReceivingStep.PRODUCT, ReceivingStep.REVIEW_PRODUCT -> "Product SKU for ${before.session?.code}"
                        else -> "Carton for ${before.session?.arrival?.code}"
                    })
                }
                mutable.update { it.copy(message = message, authExpired = (failure is WorkerRepository.ApiException && failure.code == 401) || failure is SessionChangedFailure) }
                signal(message.tone, message.title, message.detail, message.scanned)
            } finally {
                mutable.update { it.copy(busy = false, step = if (it.pending != null && it.pending.confirmedReceipt == null) ReceivingStep.RECONCILE else it.step) }
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

    @Synchronized private fun signal(tone: MessageTone, title: String, detail: String, code: String?) {
        notifications.tryEmit(ReceivingSignal(++signalId, tone, title, detail, code))
    }

    private fun reason(session: ReceivingSession, fallback: String) =
        WorkerMessages.reason(session.discrepancies.firstOrNull { it.status == "OPEN" && it.type == session.flash?.kind }?.reason, fallback)

    companion object {
        private val captureSteps = setOf(ReceivingStep.ARRIVAL, ReceivingStep.CARTON, ReceivingStep.TOTE, ReceivingStep.PRODUCT)
        private val requiredPermissions = setOf(WorkerAccess.VIEW_RECEIVING, WorkerAccess.EXECUTE_RECEIVING)
        private val closedStatuses = setOf("COMPLETED", "COMPLETED_WITH_DISCREPANCY", "CANCELLED")
    }
}

private fun kotlinx.serialization.json.JsonElement?.field(key: String): String? =
    ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
