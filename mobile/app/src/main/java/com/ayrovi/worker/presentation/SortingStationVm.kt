package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.SortingResult
import com.ayrovi.worker.data.SortingStoreResult
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * CUSTOMER SORTING station gateway — the same backend contract the frozen
 * rollback app used (fulfillment sorting endpoints), now behind an interface
 * so the native station is harness-testable without a server.
 */
interface SortingGateway {
    suspend fun scan(articleCode: String): SortingResult
    suspend fun store(articleCode: String, locationCode: String): SortingStoreResult
}

class RepoSortingGateway(private val repo: WorkerRepository) : SortingGateway {
    override suspend fun scan(articleCode: String): SortingResult = repo.sortingScan(articleCode)
    override suspend fun store(articleCode: String, locationCode: String): SortingStoreResult =
        repo.sortingStore(articleCode, locationCode)
}

/** The two questions of the station, in order: WHERE does it go → CONFIRM the location. */
enum class SortingStep { ARTICLE, LOCATION }

data class SortingUiState(
    val busy: Boolean = false,
    val step: SortingStep = SortingStep.ARTICLE,
    val decision: SortingResult? = null,
    val stored: Int = 0,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val authExpired: Boolean = false,
)

/**
 * CUSTOMER SORTING station view model (native worker app / CT40).
 *
 * Zero-touch by design: scanning the article reveals the destination, and
 * scanning the location IS the confirmation (STORED) — no confirm button in
 * the happy path. SUCCESS verdicts flash green and re-arm automatically
 * (the loop resets itself); stop verdicts (REJECTED / NEEDS REVIEW / errors)
 * stay in the foreground until BACK, and the next hardware scan replaces a
 * shown verdict instead of stacking on it.
 */
class SortingViewModel(
    private val gateway: SortingGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    private val mutable = MutableStateFlow(SortingUiState())
    val state = mutable.asStateFlow()
    val scanner = ScannerManager()

    private var foreground = false

    /** Scanning is armed only while this screen is visible and not mid-write. */
    val captureAllowed: Boolean get() = foreground && !mutable.value.busy

    fun setForeground(value: Boolean) {
        foreground = value
    }

    private fun signal(tone: MessageTone) {
        if (!foreground) return
        when (tone) {
            MessageTone.SUCCESS -> audio.success()
            MessageTone.ERROR -> audio.error()
            MessageTone.WARNING -> audio.warning()
            MessageTone.INFO -> Unit
        }
    }

    /** Hardware/QR/OCR bridge: the capture host speaks ScanResult. */
    fun onScan(result: com.ayrovi.worker.scanner.ScanResult) = scan(result.value)

    fun scan(value: String) {
        val current = mutable.value
        if (current.busy) return
        val term = value.trim()
        if (term.isEmpty()) return
        // A new hardware scan replaces a shown verdict (never stacks on it).
        mutable.value = current.copy(busy = true, message = null)
        viewModelScope.launch {
            try {
                if (current.step == SortingStep.ARTICLE) scanArticle(term) else storeAt(term)
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 401) {
                    mutable.value = mutable.value.copy(busy = false, authExpired = true)
                } else {
                    fail(ex.message ?: "The request failed.")
                }
            } catch (ex: Exception) {
                fail(ex.message ?: "The request failed.")
            }
        }
    }

    private suspend fun scanArticle(term: String) {
        val r = gateway.scan(term)
        when (r.kind) {
            "DESTINATION" -> {
                mutable.value = mutable.value.copy(
                    busy = false, decision = r, step = SortingStep.LOCATION, scanEpoch = mutable.value.scanEpoch + 1,
                    message = OperationalMessage("DESTINATION", "Scan the location to confirm.", MessageTone.INFO),
                )
                signal(MessageTone.INFO)
            }
            "NEEDS_REVIEW" -> stop("MANUAL REVIEW REQUIRED", r.article?.sku ?: term, MessageTone.WARNING)
            "REJECTED" -> stop(r.reason ?: "REJECTED", r.article?.sku ?: term, MessageTone.ERROR)
            else -> stop(
                if (r.kind == "UNMAPPED") "NO DESTINATION CONFIGURED" else "AMBIGUOUS DESTINATION",
                r.article?.sku ?: term, MessageTone.ERROR)
        }
    }

    private suspend fun storeAt(term: String) {
        val d = mutable.value.decision
        val article = d?.article?.code
        if (d?.kind != "DESTINATION" || article.isNullOrBlank()) {
            mutable.value = mutable.value.copy(step = SortingStep.ARTICLE, decision = null, busy = false)
            return
        }
        val res = gateway.store(article, term)
        val artLabel = res.flash?.sku ?: d.article?.sku ?: d.article?.code ?: term
        val location = res.flash?.location ?: term
        mutable.value = mutable.value.copy(
            busy = false, decision = null, step = SortingStep.ARTICLE,
            stored = mutable.value.stored + 1, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage("STORED", "$artLabel → $location", MessageTone.SUCCESS),
        )
        signal(MessageTone.SUCCESS)
    }

    private fun stop(title: String, detail: String, tone: MessageTone) {
        mutable.value = mutable.value.copy(busy = false, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage(title, detail, tone))
        signal(tone)
    }

    private fun fail(detail: String) {
        mutable.value = mutable.value.copy(busy = false, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage("ERROR", detail, MessageTone.ERROR))
        signal(MessageTone.ERROR)
    }

    fun dismissResult() {
        mutable.value = mutable.value.copy(message = null)
    }
}
