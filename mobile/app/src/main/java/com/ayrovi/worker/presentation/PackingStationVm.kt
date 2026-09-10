package com.ayrovi.worker.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.ayrovi.worker.data.PackResult
import com.ayrovi.worker.data.PackingView
import com.ayrovi.worker.data.WorkerRepository
import com.ayrovi.worker.domain.AudioFeedback
import com.ayrovi.worker.domain.MessageTone
import com.ayrovi.worker.domain.OperationalMessage
import com.ayrovi.worker.scanner.ScannerManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * PACKING station gateway — the same backend contract the frozen rollback
 * app used (fulfillment packing endpoints), behind an interface so the
 * native station is harness-testable without a server.
 */
interface PackingGateway {
    suspend fun scan(binCode: String): PackingView
    suspend fun pack(binCode: String): PackResult
}

class RepoPackingGateway(private val repo: WorkerRepository) : PackingGateway {
    override suspend fun scan(binCode: String): PackingView = repo.packingScan(binCode)
    override suspend fun pack(binCode: String): PackResult = repo.pack(binCode)
}

data class PackingUiState(
    val busy: Boolean = false,
    val packedToday: Int = 0,
    val lastShipment: String? = null,
    val message: OperationalMessage? = null,
    val scanEpoch: Int = 0,
    val authExpired: Boolean = false,
)

/**
 * PACKING station view model (native worker app / CT40).
 *
 * Zero-touch: scanning a COMPLETE customer bin IS the pack decision — the
 * shipment is created immediately and the green verdict (PACKED → code)
 * flashes and re-arms. An INCOMPLETE bin is a persistent amber stop verdict
 * listing exactly what is missing; the worker fills the bin and re-scans it
 * (the next scan replaces the verdict, §28).
 */
class PackingViewModel(
    private val gateway: PackingGateway,
    private val audio: AudioFeedback = AudioFeedback.Silent,
) : ViewModel() {
    private val mutable = MutableStateFlow(PackingUiState())
    val state = mutable.asStateFlow()
    val scanner = ScannerManager()

    private var foreground = false
    private var available = true

    val captureAllowed: Boolean get() = foreground && available && !mutable.value.busy

    fun setForeground(value: Boolean) {
        foreground = value
    }

    /** Connection gate from the app shell (OFFLINE / AUTH errors disarm scanning). */
    fun setAvailable(value: Boolean) {
        available = value
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
        mutable.value = current.copy(busy = true, message = null)
        viewModelScope.launch {
            try {
                scanBin(term)
            } catch (ex: WorkerRepository.ApiException) {
                if (ex.code == 401) {
                    mutable.value = mutable.value.copy(busy = false, authExpired = true)
                } else {
                    stop("ERROR", ex.message ?: "The request failed.", MessageTone.ERROR)
                }
            } catch (ex: Exception) {
                stop("ERROR", ex.message ?: "The request failed.", MessageTone.ERROR)
            }
        }
    }

    private suspend fun scanBin(binCode: String) {
        val v = gateway.scan(binCode)
        if (v.complete) {
            val r = gateway.pack(v.bin.code)
            val shipment = r.shipment?.code ?: v.bin.code
            mutable.value = mutable.value.copy(
                busy = false, packedToday = mutable.value.packedToday + 1, lastShipment = shipment,
                scanEpoch = mutable.value.scanEpoch + 1,
                message = OperationalMessage(
                    "PACKED → $shipment",
                    listOfNotNull(v.order.customer.takeIf { it.isNotBlank() }, r.shipment?.labelValue)
                        .joinToString(" · ").ifBlank { "Label ready." },
                    MessageTone.SUCCESS,
                ),
            )
            signal(MessageTone.SUCCESS)
        } else {
            val missing = v.required.filter { it.inBin < it.requested }
            val lines = missing.take(6).joinToString("\n") { "· ${it.sku ?: "—"}  ${it.inBin}/${it.requested}" }
            stop(
                "ORDER INCOMPLETE · ${v.bin.code}",
                "Missing ${missing.size} of ${v.required.size} items — fill the bin and scan it again." +
                    (if (lines.isNotBlank()) "\n$lines" else ""),
                MessageTone.WARNING,
            )
            signal(MessageTone.WARNING)
        }
    }

    private fun stop(title: String, detail: String, tone: MessageTone) {
        mutable.value = mutable.value.copy(busy = false, scanEpoch = mutable.value.scanEpoch + 1,
            message = OperationalMessage(title, detail, tone))
        signal(tone)
        return
    }

    fun dismissResult() {
        mutable.value = mutable.value.copy(message = null)
    }
}
