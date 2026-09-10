package com.ayrovi.worker.domain

import com.ayrovi.worker.data.*
import com.ayrovi.worker.scanner.ScanResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * RECEIVING HOME workflow (card-based receiving rebuild).
 *
 *   CRM ──▶ Admin Web ──▶ automatic backend dispatch ──▶ RECEIVING HOME
 *
 * RECEIVING never opens the scanner directly. It opens a home with two
 * independent lanes — PRODUIT and CARTON — each showing a live count of the
 * cards dispatched to this worker. The lists show WHAT arrived (references);
 * the worker never chooses a card:
 *
 *   [ PRODUIT SCAN ] → device matches the scanned product identifier against
 *                      the PRODUCT cards only → MATCH → CONFIRM
 *   [ CARTON  SCAN ] → device matches against the CARTON cards only → MATCH → CONFIRM
 *
 * The two lanes are STRICTLY separated: a product scan can never confirm a
 * carton and vice versa. The device match is primary; the backend
 * (/v1/receiving/home endpoints) is the final authority for validation, persistence,
 * state update, duplicate protection and the worker activity log. A MISMATCH
 * confirms nothing and completes nothing.
 */
enum class HomeStep { HOME, PRODUCT_SCAN, CARTON_SCAN, REVIEW_PRODUCT, REVIEW_CARTON }

/** Device-side MATCH preview for the PRODUIT lane. */
data class HomeProductReview(val scan: ScanResult, val card: ProductCard, val startedAt: Long)

/** Device-side MATCH preview for the CARTON lane. */
data class HomeCartonReview(val scan: ScanResult, val card: CartonCard, val matchedOn: String, val startedAt: Long)

data class ReceivingHomeState(
    val step: HomeStep = HomeStep.HOME,
    val busy: Boolean = false,
    val loaded: Boolean = false,
    val serverAvailable: Boolean = false,
    val authorized: Boolean = false,
    val authExpired: Boolean = false,
    val home: ReceivingHome? = null,
    val productReview: HomeProductReview? = null,
    val cartonReview: HomeCartonReview? = null,
    val message: OperationalMessage? = null,
    val lastScanValue: String? = null,
    /** Bumped after every scanner-relevant state change to re-arm the capture host. */
    val scanEpoch: Int = 0,
) {
    /** Scanning is allowed only inside a dedicated lane scanner. */
    val canScan: Boolean
        get() = loaded && !busy && authorized && serverAvailable && !authExpired &&
            step in setOf(HomeStep.PRODUCT_SCAN, HomeStep.CARTON_SCAN)
    val canMutate: Boolean
        get() = loaded && !busy && authorized && serverAvailable && !authExpired
    val canConfirm: Boolean
        get() = canMutate &&
            ((step == HomeStep.REVIEW_PRODUCT && productReview != null) ||
                (step == HomeStep.REVIEW_CARTON && cartonReview != null))
}

class ReceivingHomeWorkflow(
    private val gateway: ReceivingGateway,
    private val workerId: String,
    permissions: Set<String>,
    private val scope: CoroutineScope,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var permissions = permissions
    private val mutable = MutableStateFlow(
        ReceivingHomeState(authorized = requiredPermissions.all { it in permissions }),
    )
    val state = mutable.asStateFlow()

    private var signalId = 0L
    private val notifications = MutableSharedFlow<ReceivingSignal>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val events = notifications.asSharedFlow()

    private var autoRefresh: kotlinx.coroutines.Job? = null
    private var foreground = false

    /**
     * Refresh the real server feed while Home is visible. The refresh updates
     * cards/counters only; it must never manufacture a "new card" message
     * from a local counter delta. System-tray notification ownership stays in
     * WorkerAppViewModel, which compares the authoritative feed.
     */
    fun startAutoRefresh() {
        foreground = true
        autoRefresh?.cancel()
        autoRefresh = scope.launch {
            while (isActive) {
                delay(30_000)
                if (mutable.value.step == HomeStep.HOME && !mutable.value.busy) runCatching { loadHome() }
            }
        }
    }

    fun stopAutoRefresh() {
        foreground = false
        autoRefresh?.cancel()
        autoRefresh = null
    }

    fun updateAccess(permissions: Set<String>, serverAvailable: Boolean) {
        this.permissions = permissions
        mutable.update { it.copy(authorized = requiredPermissions.all(permissions::contains), serverAvailable = serverAvailable) }
    }

    fun initialize() = run(readOnly = true) { loadHome() }

    fun refresh() = run(readOnly = true) { loadHome() }

    private suspend fun loadHome() {
        val home = gateway.receivingHome()
        mutable.update {
            it.copy(
                home = home,
                loaded = true,
                // A successful server refresh clears only the old Home flash.
                // It never creates a synthetic notification from count changes.
                message = if (it.step == HomeStep.HOME) null else it.message,
                step = if (it.step !in openSteps) HomeStep.HOME else it.step,
            )
        }
    }

    /** Enter a lane scanner. PRODUIT only ever sees product cards; CARTON only carton cards. */
    /**
     * MASTER ORDER §27/§28: acknowledge the scan verdict shown in the
     * foreground result. The work step itself is untouched — only the message
     * (the verdict) is cleared.
     */
    fun dismissResult() {
        mutable.update { it.copy(message = null) }
    }

    fun openProduct() = run(readOnly = true) {
        mutable.update { it.copy(step = HomeStep.PRODUCT_SCAN, productReview = null, cartonReview = null,
            message = OperationalMessage("PRODUCT SCANNER", "Scan a product QR / barcode or read the SKU with OCR.", MessageTone.INFO),
            lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun openCarton() = run(readOnly = true) {
        mutable.update { it.copy(step = HomeStep.CARTON_SCAN, productReview = null, cartonReview = null,
            message = OperationalMessage("CARTON SCANNER", "Scan a carton QR / barcode, carton reference or tracking number.", MessageTone.INFO),
            lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun backToHome() {
        mutable.update { it.copy(step = HomeStep.HOME, productReview = null, cartonReview = null, message = null,
            lastScanValue = null, scanEpoch = it.scanEpoch + 1) }
    }

    fun scan(result: ScanResult) {
        if (!mutable.value.canScan) return
        mutable.update { it.copy(lastScanValue = result.value) }
        when (mutable.value.step) {
            HomeStep.PRODUCT_SCAN -> reviewProduct(result)
            HomeStep.CARTON_SCAN -> reviewCarton(result)
            else -> Unit
        }
    }

    // ---------- PRODUIT lane: device-side product card matching ----------
    private fun reviewProduct(scan: ScanResult) = run {
        val home = mutable.value.home ?: return@run
        val term = CardMatcher.normalize(scan.value)
        if (term.isEmpty()) return@run notice("EMPTY SCAN", "No code was read. Scan again.")
        val card = CardMatcher.matchProduct(home.productCards, term)
        when {
            card != null && card.received < card.expected -> {
                // AUTO-APPROVE: a valid scan needs no human confirmation.
                // SCAN -> VERIFY (backend) -> APPROVE -> NEXT. The review
                // state is still set first so the UI can show WHAT matched
                // while the backend call is in flight; it is cleared by
                // applyResult, which returns the lane to its scanner.
                mutable.update { it.copy(step = HomeStep.REVIEW_PRODUCT, productReview = HomeProductReview(scan, card, clock()), cartonReview = null,
                    message = OperationalMessage("MATCH FOUND", "Verifying and recording automatically...", MessageTone.INFO, scanned = term)) }
                signal(MessageTone.SUCCESS, "PRODUCT MATCH", card.productName ?: card.sku ?: term, card.sku ?: term)
                confirmProduct()
            }
            card != null -> {
                mutable.update { it.copy(productReview = null, cartonReview = null, scanEpoch = it.scanEpoch + 1,
                    message = OperationalMessage("CARD ALREADY COMPLETE", "${card.sku ?: term} is fully received. Nothing was counted again.", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "CARD ALREADY COMPLETE", "Nothing was counted again.", card.sku ?: term)
            }
            else -> reportMismatch("PRODUCT", term, scan)
        }
    }

    // ---------- CARTON lane: device-side carton card matching ----------
    private fun reviewCarton(scan: ScanResult) = run {
        val home = mutable.value.home ?: return@run
        val term = CardMatcher.normalize(scan.value)
        if (term.isEmpty()) return@run notice("EMPTY SCAN", "No code was read. Scan again.")
        when (val verdict = CardMatcher.matchCarton(home.cartonCards, term)) {
            is CardMatcher.CartonVerdict.Card -> {
                // AUTO-APPROVE (same rule as the PRODUIT lane).
                mutable.update { it.copy(step = HomeStep.REVIEW_CARTON, cartonReview = HomeCartonReview(scan, verdict.card, verdict.matchedOn, clock()), productReview = null,
                    message = OperationalMessage("MATCH FOUND", "Verifying and recording automatically...", MessageTone.INFO, scanned = term)) }
                signal(MessageTone.SUCCESS, "CARTON MATCH", "${verdict.card.externalCartonId ?: term} · ${verdict.matchedOn}", verdict.card.externalCartonId ?: term)
                confirmCarton()
            }
            is CardMatcher.CartonVerdict.AllReceived -> {
                mutable.update { it.copy(productReview = null, cartonReview = null, scanEpoch = it.scanEpoch + 1,
                    message = OperationalMessage("CARTON ALREADY RECEIVED", "${verdict.card.externalCartonId ?: term} was already received. It will not be counted again.", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "CARTON ALREADY RECEIVED", "Scan the next carton.", verdict.card.externalCartonId ?: term)
            }
            is CardMatcher.CartonVerdict.Ambiguous -> {
                val codes = verdict.candidates.joinToString(", ") { it.externalCartonId ?: "?" }
                mutable.update { it.copy(productReview = null, cartonReview = null, scanEpoch = it.scanEpoch + 1,
                    message = OperationalMessage("SEVERAL CARTONS MATCH", "The tracking number matches ${verdict.candidates.size} cartons. Scan the specific carton: $codes", MessageTone.WARNING, scanned = term)) }
                signal(MessageTone.WARNING, "SEVERAL CARTONS MATCH", "Scan the specific carton: $codes", term)
            }
            CardMatcher.CartonVerdict.NotMatched -> reportMismatch("CARTON", term, scan)
        }
    }

    /** Device-side MISMATCH: log on the backend; nothing is confirmed/completed.
     *  Called from inside an already-running `run` action (the caller has set
     *  busy=true), so it must NOT re-enter the `run` guard. */
    private suspend fun reportMismatch(cardType: String, term: String, scan: ScanResult) {
        val result = gateway.homeMismatch(cardType, term, scan.scanType, scan.source.name, iso(clock()))
        if (result.home != null) mutable.update { it.copy(home = result.home, productReview = null, cartonReview = null, scanEpoch = it.scanEpoch + 1) }
        mutable.update {
            it.copy(message = OperationalMessage("NOT MATCHED",
                if (cardType == "PRODUCT") "No product card matches this code. The failure was logged."
                else "No carton card matches this code. The failure was logged.",
                MessageTone.ERROR, scanned = term))
        }
        signal(MessageTone.ERROR, "NOT MATCHED", "Logged. Check the label or ask your supervisor.", term)
    }

    /**
     * Re-submit the failed attempt after a red error (RETRY). The review kept
     * by the failure path is re-entered and confirmed again with a fresh
     * operation id. A no-op unless a failed attempt is pending — success and
     * lane changes clear the review, so RETRY can never double-count.
     */
    fun retry() {
        // No pending attempt -> leave the lane (and its success message)
        // untouched. Never entered through `run`, so nothing is cleared.
        if (mutable.value.productReview == null && mutable.value.cartonReview == null) return
        run {
            when {
            mutable.value.productReview != null -> {
                mutable.update { it.copy(step = HomeStep.REVIEW_PRODUCT,
                    message = OperationalMessage("RETRYING", "Verifying and recording automatically...", MessageTone.INFO)) }
                confirmProduct()
            }
            mutable.value.cartonReview != null -> {
                mutable.update { it.copy(step = HomeStep.REVIEW_CARTON,
                    message = OperationalMessage("RETRYING", "Verifying and recording automatically...", MessageTone.INFO)) }
                confirmCarton()
            }
            else -> Unit
            }
        }
    }

    fun confirm() = run {
        when (mutable.value.step) {
            HomeStep.REVIEW_PRODUCT -> confirmProduct()
            HomeStep.REVIEW_CARTON -> confirmCarton()
            else -> Unit
        }
    }

    private suspend fun confirmProduct() {
        val review = mutable.value.productReview ?: return
        val term = CardMatcher.normalize(review.scan.value)
        val result = gateway.homeConfirmProduct(term, review.scan.scanType, 1, newId(), review.scan.source.name, iso(review.startedAt))
        applyResult(result, HomeStep.PRODUCT_SCAN, "PRODUCT")
    }

    private suspend fun confirmCarton() {
        val review = mutable.value.cartonReview ?: return
        val term = CardMatcher.normalize(review.scan.value)
        val result = gateway.homeConfirmCarton(term, review.scan.scanType, newId(), review.scan.source.name, iso(review.startedAt))
        applyResult(result, HomeStep.CARTON_SCAN, "CARTON")
    }

    private suspend fun applyResult(result: HomeScanResult, laneStep: HomeStep, lane: String) {
        // The backend is the final authority for completion state. Prefer the
        // fresh, complete feed returned with the verdict; when the server only
        // answered with a flash (e.g. a mismatch without a feed), re-pull the
        // home feed ourselves so a completed card ALWAYS leaves the active
        // queue immediately — no app close / re-login required.
        val home = result.home ?: runCatching { gateway.receivingHome() }.getOrNull()
        if (home != null) mutable.update { it.copy(home = home) }
        mutable.update { it.copy(productReview = null, cartonReview = null, step = laneStep, scanEpoch = it.scanEpoch + 1) }
        // The verdict is VISIBLE on the lane (green success / red error), not
        // just a sound/signal: the worker always sees WHAT the backend decided.
        val flash = result.flash
        val verdict = when (flash?.kind) {
            "MATCH" -> Triple(MessageTone.SUCCESS, if (lane == "PRODUCT") "PRODUCT RECEIVED" else "CARTON RECEIVED",
                flash.message ?: "Verified and recorded.")
            "CARD_ALREADY_COMPLETE" -> Triple(MessageTone.WARNING, "CARD ALREADY COMPLETE", "Nothing was counted again.")
            "TRACKING_AMBIGUOUS" -> Triple(MessageTone.WARNING, "SEVERAL CARTONS MATCH",
                flash.message ?: "Scan the specific carton.")
            "WRONG_SHIPMENT" -> Triple(MessageTone.ERROR, "WRONG SHIPMENT",
                flash.message ?: "This carton belongs to another arrival.")
            else -> Triple(MessageTone.ERROR, "NOT MATCHED",
                flash?.message ?: "The backend could not match this identifier.")
        }
        mutable.update { it.copy(message = OperationalMessage(verdict.second, verdict.third, verdict.first, scanned = flash?.code)) }
        signal(verdict.first, verdict.second, verdict.third, flash?.code)
    }

    @Synchronized
    private fun run(readOnly: Boolean = false, action: suspend () -> Unit) {
        val before = mutable.value
        if (before.busy || before.authExpired) return
        val permitted = readOnly || requiredPermissions.all(permissions::contains)
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
                val message = failure.toOperationalMessage()
                mutable.update {
                    it.copy(message = message, authExpired = (failure is WorkerRepository.ApiException && failure.code == 401),
                        // A failed VERIFY must never strand the lane on its
                        // "Verifying..." review: fall back to the lane scanner
                        // with the red error. The review itself is KEPT so RETRY
                        // can re-submit the exact same attempt.
                        step = when (it.step) {
                            HomeStep.REVIEW_PRODUCT -> HomeStep.PRODUCT_SCAN
                            HomeStep.REVIEW_CARTON -> HomeStep.CARTON_SCAN
                            else -> it.step
                        },
                        scanEpoch = it.scanEpoch + 1)
                }
                signal(message.tone, message.title, message.detail, message.scanned)
            } finally {
                mutable.update { it.copy(busy = false) }
            }
        }
    }

    private fun notice(title: String, detail: String, scanned: String? = null) {
        val safe = WorkerMessages.reason(detail, "Check the label or ask your supervisor.")
        mutable.update { it.copy(message = OperationalMessage(title, safe, scanned = scanned)) }
        signal(MessageTone.ERROR, title, safe, scanned)
    }

    private fun iso(epochMillis: Long): String = java.time.Instant.ofEpochMilli(epochMillis).toString()

    @Synchronized
    private fun signal(tone: MessageTone, title: String, detail: String, code: String?) {
        notifications.tryEmit(ReceivingSignal(++signalId, tone, title, detail, code))
    }

    companion object {
        private val openSteps = setOf(HomeStep.PRODUCT_SCAN, HomeStep.CARTON_SCAN, HomeStep.REVIEW_PRODUCT, HomeStep.REVIEW_CARTON)
        private val requiredPermissions = setOf(WorkerAccess.VIEW_RECEIVING, WorkerAccess.EXECUTE_RECEIVING)
    }
}
